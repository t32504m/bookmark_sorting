"""収集スクリプトが書き出した JSONL(1行1応答)を確かめる。

使い方:
    python tools/check_raw.py                 # raw/ フォルダの *.jsonl をすべて読む
    python tools/check_raw.py raw/a.jsonl ... # ファイルやフォルダを指定する

DB への格納はステップ2の作業であり、ここでは件数を数えて表示するだけにする。
応答の構造は twitter-web-exporter のソースからの推測で、実物では未検証。
"""

import json
import sys
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

X_HOSTS = {"x.com", "twitter.com", "www.x.com", "www.twitter.com", "mobile.x.com", "mobile.twitter.com", "t.co"}


def iter_files(args):
    targets = [Path(a) for a in args] or [Path("raw")]
    for t in targets:
        if t.is_dir():
            yield from sorted(t.glob("*.jsonl"))
        else:
            yield t


def read_records(files):
    """読めない行は飛ばして標準エラーに記録し、残りを返す。"""
    records, bad = [], 0
    for f in files:
        with open(f, encoding="utf-8") as fh:
            for n, line in enumerate(fh, 1):
                if not line.strip():
                    continue
                try:
                    records.append(json.loads(line))
                except json.JSONDecodeError as e:
                    bad += 1
                    print(f"[読めない行] {f}:{n}: {e}", file=sys.stderr)
    return records, bad


def unwrap(result):
    if isinstance(result, dict) and result.get("__typename") == "TweetWithVisibilityResults":
        return result.get("tweet")
    return result


def parse_time(s):
    try:
        return datetime.strptime(s, "%a %b %d %H:%M:%S %z %Y")
    except (TypeError, ValueError):
        return None


def media_of(tweet):
    legacy = tweet.get("legacy", {})
    return (legacy.get("extended_entities") or legacy.get("entities") or {}).get("media") or []


def external_urls(tweet):
    urls = tweet.get("legacy", {}).get("entities", {}).get("urls") or []
    out = []
    for u in urls:
        host = urlparse(u.get("expanded_url") or "").hostname or ""
        if host.lower() not in X_HOSTS:
            out.append(u.get("expanded_url"))
    return out


def main(argv):
    files = list(iter_files(argv))
    if not files:
        print("JSONL ファイルが見つかりません")
        return 1
    records, bad = read_records(files)

    # 同じ応答を複数のファイルに書き出した場合に備え、取得日時と連番で重複を除く
    seen, responses = set(), []
    for r in records:
        key = (r.get("captured_at"), r.get("seq"))
        if key not in seen:
            seen.add(key)
            responses.append(r)
    responses.sort(key=lambda r: r.get("captured_at") or "")

    status_counts = {}
    posts = {}  # id -> tweet(表示できない投稿は None)
    sort_index = {}  # id -> sortIndex(文字列)
    bottom_cursors, req_cursors = set(), []
    non_string_ids = 0
    bodies_not_json = 0
    responses_with_errors = 0

    for r in responses:
        status_counts[r.get("status")] = status_counts.get(r.get("status"), 0) + 1
        body = r.get("body")
        if not isinstance(body, dict):
            bodies_not_json += 1
            continue
        if body.get("errors"):
            responses_with_errors += 1
        if r.get("req_cursor"):
            req_cursors.append(r["req_cursor"])
        timeline = (body.get("data") or {}).get("bookmark_timeline_v2", {}).get("timeline", {})
        for ins in timeline.get("instructions") or []:
            for entry in ins.get("entries") or []:
                eid = str(entry.get("entryId", ""))
                content = entry.get("content") or {}
                if eid.startswith("cursor-bottom"):
                    bottom_cursors.add(content.get("value"))
                if not eid.startswith("tweet-"):
                    continue
                tweet = unwrap((content.get("itemContent") or {}).get("tweet_results", {}).get("result"))
                ok = isinstance(tweet, dict) and "legacy" in tweet
                if ok and not isinstance(tweet.get("rest_id"), str):
                    non_string_ids += 1
                pid = tweet["rest_id"] if ok and isinstance(tweet.get("rest_id"), str) else eid[len("tweet-"):]
                if ok or pid not in posts:
                    posts[pid] = tweet if ok else None
                sort_index[pid] = entry.get("sortIndex")

    available = {k: v for k, v in posts.items() if v is not None}
    times = [t for t in (parse_time(v["legacy"].get("created_at")) for v in available.values()) if t]

    has_image = has_video = has_link = has_quote = has_card = has_long = image_and_link = 0
    quote_missing = 0
    samples = {}  # 種別 -> media_url_https
    for t in available.values():
        media = media_of(t)
        img = any(m.get("type") == "photo" for m in media)
        vid = any(m.get("type") in ("video", "animated_gif") for m in media)
        link = bool(external_urls(t))
        quote = bool(t.get("quoted_status_result")) or bool(t["legacy"].get("is_quote_status"))
        has_image += img
        has_video += vid
        has_link += link
        has_quote += quote
        image_and_link += img and link
        has_card += bool(t.get("card"))
        has_long += bool(t.get("note_tweet"))
        if quote and not unwrap((t.get("quoted_status_result") or {}).get("result")):
            quote_missing += 1
        for m in media:
            samples.setdefault(m.get("type"), m.get("media_url_https"))

    missing_links = [c for c in req_cursors if c not in bottom_cursors]

    print(f"読んだファイル: {len(files)} 件 / 読めない行: {bad} 件")
    print(f"応答数(重複除外): {len(responses)}  状態コード別: {status_counts}")
    print(f"  本文が JSON でない応答: {bodies_not_json} / errors を含む応答: {responses_with_errors}")
    print(f"投稿数(重複除外): {len(posts)}(うち表示できない投稿: {len(posts) - len(available)})")
    if times:
        print(f"最古の投稿日時: {min(times).isoformat()}")
        print(f"最新の投稿日時: {max(times).isoformat()}")
    print(f"画像付き: {has_image} / 動画・GIF付き: {has_video} / 外部リンク付き: {has_link} / 引用付き: {has_quote}")
    print(f"  画像と外部リンクの両方: {image_and_link} / リンクカードあり: {has_card} / 長文(note_tweet): {has_long}")
    print(f"  引用だが引用元が取れていない: {quote_missing}")
    print(f"IDが文字列でない投稿: {non_string_ids}")
    print(
        f"取り逃しの確認: 続きの読み込み {len(req_cursors)} 回のうち、"
        f"直前の応答が記録されていないもの {len(missing_links)} 回"
    )
    si = [v for v in sort_index.values() if v]
    if si:
        si_int = sorted(int(v) for v in si)
        print(f"sortIndex: 最小 {si_int[0]} / 最大 {si_int[-1]}(並び順の手がかり。意味は未検証)")
    if samples:
        print("name= の確認用(ブラウザで開いて表示と大きさを見る):")
        for kind, url in samples.items():
            if not url:
                continue
            base = url.rpartition(".")[0]
            print(f"  [{kind}] {url}?name=small")
            print(f"  [{kind}] {url}?name=large")
            print(f"  [{kind}] {base}?format=webp&name=small")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
