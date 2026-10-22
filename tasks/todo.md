# Task Checklist: カプセルタスク（Capsule Tasks） — Vite + React / Hono / Cloudflare

## Phase 1：MVP（コア画面・ローカル永続化基盤・AI一気通貫ループの実装）
- [x] **Task 1.1**: Vite+React（フロントエンド）＆ Hono+Cloudflare Workers（バックエンド）基盤構築とモバイル共通レイアウト実装
- [x] **Task 1.2**: データモデル定義と localStorage / IndexedDB 永続化フックの実装
  - [x] PR #24 レビュー修正：保存失敗後のタスク巻き戻り防止、タブ間排他制御、v1データ移行・破損v2復旧後の再取り込み防止・ロック非対応時のメモリ保持と回帰テスト
- [x] **Task 1.3**: Web Audio API シンセサイザー効果音＆ハプティクス演出フックの実装
- [x] **Task 1.4**: メイン画面（ガチャステージ）と1画面1カプセル操作UI（開封・先送り・リサイクル）の実装
- [ ] **Task 1.5**: Hono Gemini API プロキシと `gemini-3.8-flash` 音声ボヤき・常連スタンプ補充機能の実装
- [ ] **Task 1.6**: `gemini-nano-banana-2.1` 記念メダル動的生成 Hono API とカプセル開封モーダル・コレクション棚（基本版）の実装
- [ ] **Task 1.7**: ガチャ演出・カプセル質感・マイクロインタラクション等のUI/UX改善と演出強化
- [x] **Task 1.8**: 開発ガイドライン（AGENTS.md）策定と割り込みタスク運用ルールの明文化
- [ ] **Task 1.9**: 開発・ステージング環境（Development / stg ブランチ）と Cloudflare Workers Preview / CI-CD（DevOps）の構築

### Checkpoint: Phase 1 Complete
- [ ] `npm test`, `npm run lint`, `npm run build` がすべて通過する
- [ ] 音声/スタンプ補充 → 1カプセル排出 → タップ連打開封 → AI記念メダル生成 → IndexedDB図鑑保存の一気通貫ループが動作する

## Phase 2：マルチモーダル拡張・放置タイマー・非同期プリフェッチ・ミニカプセル分裂機能の強化
- [ ] **Task 2.1**: 画像・PDF＋音声の複合マルチモーダルタスク抽出機能の実装
- [ ] **Task 2.2**: カプセル排出・タイマー連動のメダル画像バックグラウンド非同期プリフェッチ機構の実装
- [ ] **Task 2.3**: 放置タイマー連動オート開封（5分/15分/25分）とブラウザタブ実況表示の実装
- [ ] **Task 2.4**: 「5分だけやる」AIミニカプセル分裂機能とスキップ回数連動サジェストの実装

### Checkpoint: Phase 2 Complete
- [ ] 写真メモ＋音声からの複合タスク抽出が動作する
- [ ] カプセル排出時のバックグラウンドプリフェッチにより、開封完了時に待ち時間ゼロでメダルが表示される
- [ ] 5/15/25分タイマー稼働中に `document.title` がリアルタイム更新され、タイマー終了で自動開封される
- [ ] 「小さく割る」ボタンおよびスキップ回数連動で5分ミニカプセルへのAI分割が動作する

## Phase 3：やり込み要素・メダル進化（Conversational Editing）・PWA化＆Cloudflareデプロイの実装
- [ ] **Task 3.1**: ボーナスコインを消費する「メダル進化（Conversational Editing）」機能の実装
- [ ] **Task 3.2**: コレクション図鑑の2K高解像度鑑賞・獲得称号システム・常連スタンプ編集機能の実装
- [ ] **Task 3.3**: メダルコレクションカードのSNSシェア画像書き出し機能の実装
- [ ] **Task 3.4**: PWA対応・Cloudflare デプロイ設定・パフォーマンス最適化・E2Eブラウザ検証

### Checkpoint: Phase 3 Complete
- [ ] 100コイン消費で既存メダルが `gemini-nano-banana-2.1` により豪華仕様へ進化する
- [ ] 図鑑での2K拡大表示・称号表示・SNSシェア画像書き出しが動作する
- [ ] PWA対応および Cloudflare Workers (`wrangler`) へのデプロイ設定が完了し、モバイルブラウザ検証をすべてクリアする
