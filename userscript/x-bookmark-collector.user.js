// ==UserScript==
// @name         X Bookmark Collector
// @namespace    https://github.com/t32504m/bookmark_sorting
// @version      0.1.0
// @description  ブックマーク画面の Bookmarks 応答を複製して記録する(要件定義書 4.1)
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        unsafeWindow
// @run-at       document-start
// ==/UserScript==

/*
 * XHR の横取り(installHook)とファイルの保存(saveFile)は、twitter-web-exporter
 * v1.4.3 の src/core/extensions/manager.ts と src/utils/exporter.ts を手本にしている。
 *
 *   MIT License
 *   Copyright (c) 2023 prin
 *   https://github.com/prinsss/twitter-web-exporter/blob/main/LICENSE
 *
 * 方針:
 * - 応答本文は文字列のまま保存し、JSON.parse した値を書き戻さない(IDの精度を守る)。
 * - リクエストヘッダは読まない。Cookie や認証トークンは保存されない。
 * - こちらから通信は送らない。画面が読み込んだ応答を複製するだけ。
 */

(function () {
  'use strict';

  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  // 未検証: 操作名と URL の形は TWE のソースからの推測(/i/api/graphql/<hash>/Bookmarks?variables=...)
  const BOOKMARKS_RE = /\/graphql\/[^/?]+\/Bookmarks(?:\?|$)/;
  const STOP_AFTER_MS = 30000; // 投稿を含む応答がこの時間届かなければ自動停止
  const DB_NAME = 'xbm_collector';

  const state = {
    graphqlSeen: 0, // 観測した graphql の XHR 数(横取りが効いているかの目安)
    bookmarksSeen: 0,
    running: false,
    timer: null,
    lastTweetsAt: 0,
    lastPost: null, // { created_at, head }
    lastError: '',
    session: null, // { started_at, stopped_at, reason, ids:Set, responses }
    contextOk: null,
  };

  /* ---------------- IndexedDB ---------------- */

  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          db.createObjectStore('responses', { keyPath: 'seq', autoIncrement: true });
          db.createObjectStore('posts', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  // fn(store1, store2, ...) の中で要求を出し、取引の完了で解決する
  async function withStores(names, mode, fn) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const t = db.transaction(names, mode);
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
      result = fn(...names.map((n) => t.objectStore(n)));
    });
  }

  function requestValue(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function countStore(name) {
    const db = await openDb();
    return requestValue(db.transaction(name).objectStore(name).count());
  }

  async function getAll(name) {
    const db = await openDb();
    return requestValue(db.transaction(name).objectStore(name).getAll());
  }

  /* ---------------- 応答の解釈(表示と件数のためだけ) ---------------- */

  // 未検証: 構造は TWE の BookmarksInterceptor と extractTweetUnion からの推測
  function extractPosts(json) {
    const posts = [];
    const instructions = json?.data?.bookmark_timeline_v2?.timeline?.instructions ?? [];
    for (const ins of instructions) {
      if (ins.type !== 'TimelineAddEntries') continue;
      for (const entry of ins.entries ?? []) {
        const entryId = String(entry.entryId ?? '');
        if (!entryId.startsWith('tweet-')) continue;
        let t = entry.content?.itemContent?.tweet_results?.result;
        if (t?.__typename === 'TweetWithVisibilityResults') t = t.tweet;
        const ok = !!t?.legacy;
        const text = ok ? (t.note_tweet?.note_tweet_results?.result?.text ?? t.legacy.full_text ?? '') : '';
        posts.push({
          id: String(ok && t.rest_id ? t.rest_id : entryId.slice('tweet-'.length)),
          created_at: ok ? t.legacy.created_at : null,
          head: ok ? text.replace(/\s+/g, ' ').slice(0, 60) : `(表示できない投稿: ${t?.__typename ?? '空'})`,
          available: ok,
        });
      }
    }
    return posts;
  }

  function cursorFromUrl(url) {
    try {
      const v = new URL(url, location.href).searchParams.get('variables');
      const c = v ? JSON.parse(v).cursor : null;
      return typeof c === 'string' ? c : null;
    } catch {
      return null;
    }
  }

  /* ---------------- 応答の記録 ---------------- */

  async function onBookmarksResponse(url, xhr) {
    state.bookmarksSeen++;
    let text;
    try {
      text = xhr.responseText;
    } catch (e) {
      // 未検証: responseType が 'json' などの場合は responseText を読めない
      state.lastError = `応答本文を読めない(responseType=${xhr.responseType})`;
      render();
      return;
    }

    let body;
    let posts = [];
    try {
      const json = JSON.parse(text);
      posts = extractPosts(json);
      // 正しい JSON では改行は文字列の外にしか現れないため、空白に置き換えて1行にする
      body = text.replace(/[\r\n]+/g, ' ');
    } catch {
      body = JSON.stringify(text); // JSON でない本文は文字列として残す
    }

    const record = {
      captured_at: new Date().toISOString(),
      op: 'Bookmarks',
      status: xhr.status,
      req_cursor: cursorFromUrl(url),
      body,
    };

    try {
      await withStores(['responses', 'posts'], 'readwrite', (responses, postStore) => {
        responses.add(record);
        for (const p of posts) postStore.put(p);
      });
    } catch (e) {
      state.lastError = `保存に失敗: ${e && e.message}`;
      if (state.running) stop('エラー(保存に失敗)');
      render();
      return;
    }

    if (state.session) {
      state.session.responses++;
      for (const p of posts) state.session.ids.add(p.id);
    }
    if (posts.length > 0) {
      state.lastTweetsAt = Date.now();
      const last = posts[posts.length - 1];
      state.lastPost = { created_at: last.created_at, head: last.head };
    }
    if (xhr.status !== 200) {
      state.lastError = `HTTP ${xhr.status}`;
      if (state.running) stop(`エラー(HTTP ${xhr.status})`);
    }
    render();
  }

  /* ---------------- XHR の横取り(TWE を手本、MIT) ---------------- */

  function installHook() {
    const xhrOpen = W.XMLHttpRequest.prototype.open;
    W.XMLHttpRequest.prototype.open = function (method, url) {
      const u = String(url);
      if (u.includes('/graphql/')) {
        state.graphqlSeen++;
        if (BOOKMARKS_RE.test(u)) {
          this.addEventListener('load', () => {
            onBookmarksResponse(u, this).catch((e) => console.error('[xbm]', e));
          });
        }
      }
      return xhrOpen.apply(this, arguments);
    };

    // TWE と同じ確認: ページの文脈に注入されていなければ横取りは効かない
    setTimeout(() => {
      state.contextOk = 'webpackChunk_twitter_responsive_web' in W;
      render();
    }, 3000);
  }

  /* ---------------- 自動スクロール ---------------- */

  function isBookmarksPage() {
    return location.pathname.startsWith('/i/history');
  }

  function start() {
    state.running = true;
    state.lastTweetsAt = Date.now();
    state.lastError = '';
    state.session = { started_at: new Date(), stopped_at: null, reason: '', ids: new Set(), responses: 0 };
    tick();
    render();
  }

  function stop(reason) {
    state.running = false;
    clearTimeout(state.timer);
    if (state.session && !state.session.stopped_at) {
      state.session.stopped_at = new Date();
      state.session.reason = reason;
    }
    render();
  }

  function tick() {
    if (!state.running) return;
    if (!isBookmarksPage()) return stop('ブックマーク画面を離れた');
    if (Date.now() - state.lastTweetsAt > STOP_AFTER_MS) {
      return stop('それ以上読み込まれなくなった(30秒間、投稿を含む応答なし)');
    }
    W.scrollBy(0, Math.round(W.innerHeight * 0.8));
    state.timer = setTimeout(tick, 1000 + Math.random() * 2000); // 1〜3秒
    render();
  }

  /* ---------------- 書き出し ---------------- */

  // TWE の saveFile を手本(MIT)。Firefox 向けに解放を少し遅らせている
  function saveFile(filename, parts) {
    const blob = new Blob(parts, { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function stamp(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function fmtDate(v) {
    if (!v) return '—';
    const d = v instanceof Date ? v : new Date(v);
    if (isNaN(d)) return String(v);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  async function exportJsonl() {
    const rows = await getAll('responses');
    if (rows.length === 0) return alert('記録した応答はまだありません');
    const lines = rows.map((r) => {
      const head = JSON.stringify({
        schema: 1,
        seq: r.seq,
        captured_at: r.captured_at,
        op: r.op,
        status: r.status,
        req_cursor: r.req_cursor,
      });
      return head.slice(0, -1) + ',"body":' + r.body + '}\n';
    });
    saveFile(`raw_${stamp()}_${rows.length}res.jsonl`, lines);
  }

  async function exportSummary() {
    const [responses, posts] = await Promise.all([getAll('responses'), getAll('posts')]);
    const times = posts.map((p) => Date.parse(p.created_at)).filter((t) => !isNaN(t));
    const s = state.session;
    const gm = typeof GM_info !== 'undefined' ? GM_info : null;
    const text = [
      'X ブックマーク収集の記録',
      `書き出し日時: ${fmtDate(new Date())}`,
      `スクリプト: ${gm ? `${gm.script.name} ${gm.script.version}` : '不明'}`,
      `拡張機能: ${gm ? `${gm.scriptHandler} ${gm.version}` : '不明'}`,
      `ブラウザ: ${navigator.userAgent}`,
      '',
      '[累計(このブラウザに記録済みの分)]',
      `応答数: ${responses.length}(うち HTTP 200 以外: ${responses.filter((r) => r.status !== 200).length})`,
      `投稿数(重複除外): ${posts.length}(うち表示できない投稿: ${posts.filter((p) => !p.available).length})`,
      `最古の投稿日時: ${times.length ? fmtDate(Math.min(...times)) : '—'}(投稿日時の最小値。ブックマークした日時ではない)`,
      `最新の投稿日時: ${times.length ? fmtDate(Math.max(...times)) : '—'}`,
      '',
      '[直近の収集(このタブで開始/停止した分)]',
      `開始: ${s ? fmtDate(s.started_at) : '—'}`,
      `終了: ${s && s.stopped_at ? fmtDate(s.stopped_at) : state.running ? '(収集中)' : '—'}`,
      `止まった理由: ${s && s.reason ? s.reason : '—'}`,
      `この収集で届いた応答数: ${s ? s.responses : 0}`,
      `この収集で届いた投稿数(重複除外): ${s ? s.ids.size : 0}`,
      `最後に届いた投稿: ${state.lastPost ? `${fmtDate(state.lastPost.created_at)} ${state.lastPost.head}` : '—'}`,
      `最後のエラー: ${state.lastError || 'なし'}`,
      '',
    ].join('\n');
    saveFile(`collect_log_${stamp()}.txt`, [text]);
  }

  async function clearAll() {
    if (!confirm('このブラウザに記録した応答をすべて消去します。JSONL を書き出し済みですか?')) return;
    await withStores(['responses', 'posts'], 'readwrite', (r, p) => {
      r.clear();
      p.clear();
    });
    state.lastPost = null;
    state.session = null;
    render();
  }

  /* ---------------- 画面の隅の表示 ---------------- */

  let panel = null;
  let infoEl = null;
  let toggleBtn = null;

  function button(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'margin:2px;padding:2px 6px;font-size:12px;cursor:pointer;';
    b.addEventListener('click', () => {
      Promise.resolve(onClick()).catch((e) => alert(`失敗しました: ${e && e.message}`));
    });
    return b;
  }

  function createPanel() {
    panel = document.createElement('div');
    panel.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:2147483647;background:rgba(0,0,0,.85);color:#fff;' +
      'font:12px/1.5 sans-serif;padding:8px;border-radius:6px;max-width:340px;white-space:pre-wrap;';
    infoEl = document.createElement('div');
    toggleBtn = button('開始', () => (state.running ? stop('自分で止めた') : start()));
    panel.append(
      infoEl,
      toggleBtn,
      button('JSONL書き出し', exportJsonl),
      button('記録テキスト', exportSummary),
      button('消去', clearAll),
    );
    document.body.appendChild(panel);
    render();
    setInterval(() => {
      panel.style.display = isBookmarksPage() ? 'block' : 'none';
    }, 1000);
  }

  let renderQueued = false;
  function render() {
    if (!infoEl || renderQueued) return;
    renderQueued = true;
    setTimeout(async () => {
      renderQueued = false;
      const [nRes, nPosts] = await Promise.all([countStore('responses'), countStore('posts')]).catch(() => ['?', '?']);
      const s = state.session;
      const lines = [
        `状態: ${state.running ? '収集中' : '停止'}${s && s.reason ? `(${s.reason})` : ''}`,
        `投稿数(重複除外・累計): ${nPosts}`,
        `  この収集で届いた分: ${s ? s.ids.size : 0}`,
        `応答数(累計): ${nRes}`,
        `最後に届いた投稿: ${state.lastPost ? fmtDate(state.lastPost.created_at) : '—'}`,
        state.lastPost ? `  ${state.lastPost.head}` : null,
        `観測: graphql ${state.graphqlSeen} 件 / Bookmarks ${state.bookmarksSeen} 件`,
        state.contextOk === false ? '警告: ページの文脈で動いていない可能性(横取りが効かない)' : null,
        state.lastError ? `エラー: ${state.lastError}` : null,
      ];
      infoEl.textContent = lines.filter((l) => l !== null).join('\n');
      toggleBtn.textContent = state.running ? '停止' : '開始';
    }, 200);
  }

  /* ---------------- 起動 ---------------- */

  installHook(); // Xのスクリプトより先に仕掛ける(@run-at document-start)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createPanel);
  } else {
    createPanel();
  }
})();
