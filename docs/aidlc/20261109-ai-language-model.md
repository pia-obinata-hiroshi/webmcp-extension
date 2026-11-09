# AI-DLC Phase Artifact: 要件・設計仕様書

> このファイルはセッション間引き継ぎの唯一の正（Single Source of Truth）。
> 後続フェーズはこのファイルと `CONTRIBUTING.md` のみを根拠に作業する（本リポジトリに AGENTS.md は存在しない）。

## 1. タスク概要

- **タスクID**: 20261109-ai-language-model
- **目的**: オンデバイスモデルバックエンド（Prompt API）を旧 Origin Trial 名前空間 API（`chrome.aiOriginTrial.languageModel` および `window.ai.languageModel`）でも利用可能にする。`LanguageModel` グローバルが存在しない環境向けフォールバックとして追加する
- **作成日**: 2026-11-09
- **スコープ**: standard
- **意図**: `LanguageModel` グローバルを持たない Chrome ビルドでも On-device model バックエンドを動作させる。レガシー API は拡張機能コンテキスト（side panel）では `chrome.aiOriginTrial.languageModel`、通常 Web ページでは `window.ai.languageModel` として露出されていたため、両名前空間を検出対象とする。レガシー側にツール呼び出し API（`LanguageModelToolCall` 等のグローバルクラス）が無い場合は、WebMCP ツール呼び出しを諦めてテキスト会話のみ提供する（グレースフルデグラデーション）。既存の `LanguageModel` 経路（ツール呼び出し・権限プロンプト・スポットライティングを含む全機能）は一切劣化させない
- **確認Q&A**:
  - Q: 対象 API 形態は？ → A: `window.ai.languageModel`（Chrome 旧 Origin Trial 系の名前空間 API）。`LanguageModel` グローバルが無い環境向けのフォールバックとして追加する
  - Q: ツール呼び出しが使えない場合の挙動は？ → A: `ai.languageModel` 側でツール呼び出し API（LanguageModelToolCall 等）が無い場合は、WebMCP ツール呼び出しを諦めてテキスト会話のみ提供する（グレースフルデグラデーション）
  - Q: 変更範囲は？ → A: 設計に委ねる（コードベース調査の上で設計者が決定）
  - Q: レガシー名前空間の検出対象は？（再確認） → A: `chrome.aiOriginTrial.languageModel` と `window.ai.languageModel` の両方を検出する。本リポジトリは Chrome 拡張であり、side panel 等の拡張機能コンテキストでは旧 Origin Trial API が `chrome.aiOriginTrial.languageModel` として露出されていた。両者のレガシー面の形状（`capabilities()` / `create()` が返すセッション）はほぼ同型のため、検出順を設けて両方をフォールバック対象とする

## 2. 変更対象コンポーネント（影響範囲）

- [ ] `extension/sidepanel/services/promptApiCompat.ts`（**新規**。`chrome.aiOriginTrial.languageModel` / `window.ai.languageModel` → `LanguageModel` 互換ファサードのアダプタ／シム層）
- [ ] `extension/sidepanel/services/promptApiBackend.ts`（API 検出の拡張・シム起動・ツール非対応時のデグラデーション）
- [ ] `tests/extension/promptApiBackend.test.ts`（レガシー名前空間スタブ・デグラデーション・検出優先順位・既存経路の非回帰テスト追加）

変更しないが関連する既存ファイル（参照のみ）:

- `extension/sidepanel/types/promptApiTools.d.ts` — `LanguageModelToolCall/Success/Error` の `declare global` 宣言。変更なし（レガシー側の型はアダプタ内のローカルインターフェースで持つ）
- `extension/sidepanel/services/chatBridge.ts`・`extension/sidepanel/App.tsx`・`extension/sidepanel/components/OnDeviceModelStatus.tsx` — `sendOnDeviceChat` / `isPromptApiSupported` / `prepareOnDeviceModel` の呼び出し側。公開シグネチャを変えないため変更不要

## 3. 実装要件（ガードレール適用）

1. **互換アダプタの新設**: `extension/sidepanel/services/promptApiCompat.ts` を新規作成し、Apache 2.0 SPDX ヘッダを付ける（CONTRIBUTING.md 規約）。レガシー名前空間のファクトリオブジェクトを現行 `LanguageModel` の静的サーフェス（`availability` / `create` / `params`）に正規化するファサードを提供する。
   - `availability(options)` が存在すればそのまま委譲。無い場合は旧式 `capabilities()` を呼び、`available` 値を `no→'unavailable'`、`readily→'available'`、`after-download→'downloadable'` にマップする
   - `create(options)` はオプションをそのまま委譲する。`initialPrompts` を受け付けない旧式シグネチャで `TypeError` / `NotSupportedError` が投げられた場合に限り、`role: 'system'` の初期プロンプトを `systemPrompt` オプションへ移し、残りを `initialPrompts` として再試行する
   - `params()` が無ければ `capabilities()` の `defaultTopK` / `maxTopK` / `defaultTemperature` / `maxTemperature` から合成し、それも無ければ `undefined` を返す
   - `create()` が返すセッションは Proxy またはラッパで正規化する: `contextUsage`（フォールバック `inputUsage` → `tokensSoFar`）、`contextWindow`（フォールバック `inputQuota` → `maxTokens`）、`promptStreaming` / `prompt` / `destroy` / `clone` / `addEventListener` は透過委譲
   - レガシー側のインターフェース（`LegacyLanguageModelFactory` 等）は同ファイル内のローカル型として定義する。`declare global` での宣言追加は行わない（`easy-language-model` が依存する `@types/dom-chromium-ai` や `@types/chrome` の既存宣言と衝突し得るため）
2. **両名前空間の検出順序**: ファクトリの検出は **`chrome.aiOriginTrial.languageModel` を先に、次に `window.ai.languageModel`** の順で行う。本拡張の実行コンテキストは拡張機能側（side panel）であり、`chrome.aiOriginTrial` は拡張機能コンテキスト向けに露出された正規の名前空間であるため優先する。片方しか存在しない環境、両方存在する環境の双方で動作し、両方ある場合は先勝ちとする。アクセスは `(globalThis as Record<string, unknown>).chrome` / `.ai` の型ガード付き参照とし、`chrome` グローバル型・`window.ai` の型宣言への依存は避ける
3. **シムの適用条件**: `ensurePromptApiShim()` を冪等な関数として実装する。`LanguageModel` が `globalThis` に既にある場合は**絶対に上書きしない**（テストスタブと将来のネイティブ実装を保護するため）。いずれかのレガシー名前空間のみ存在する場合に限り、検出順で最初に見つかったファクトリのファサードを `globalThis.LanguageModel` に代入する（代入は `as unknown as typeof LanguageModel` のキャストを1箇所に集約し、安易な `any` は使わない）
4. **検出の拡張**: `isPromptApiSupported()` は `ensurePromptApiShim()` を呼んだ上で `'LanguageModel' in globalThis` を返すように変更する（App.tsx のレンダリング時点で真となり、On-device model トグルがレガシー環境でも有効になる）。`isToolUseSupported()` の 3 グローバルクラス検査は変更しない
5. **評価順序の保証**: `promptApiCompat.ts` は `promptApiBackend.ts` の import リストで `easy-language-model` より前に side-effect import し、モジュール評価時にも（レガシー名前空間が検出できれば）シムを適用する。これにより `easy-language-model` が `LanguageModel` グローバルを遅延参照でもモジュール評価時捕捉でも動作する（パッケージ内部実装への依存を断つ設計）。さらに `isPromptApiSupported()` 経由の遅延適用で、モジュール評価後にレガシー名前空間を差し込まれるテストにも対応する
6. **グレースフルデグラデーション**: レガシー（シム経由）バックエンドでツール呼び出しクラスが無い場合、セッションをツール宣言なしで作成しテキスト会話のみ提供する。実装は `toPromptApiTools(request.tools)` の呼び出し箇所（`getSession`・`sendOnDeviceChat` の toolResponses 経路・リトライ経路の計3箇所）を `effectivePromptApiTools(request)` ヘルパに置き換え、「ツール非対応かつレガシー」なら空配列を返す。これにより `state.declarations`・履歴リプレイの `withTools` 判定・セッション再利用判定がすべて「ツールなし」で一貫する。初回のみ `console.warn('[WebMCP] The legacy Prompt API namespace does not expose tool calling; continuing without WebMCP tools.')` を出す
7. **既存挙動の維持**: ネイティブ `LanguageModel` が存在しツールクラスのみ無い（フラグ無効）ケースは、従来どおり `createSession` の `UserFacingError`（`about://flags/#prompt-api-tool-use` を案内するメッセージ）を投げる。ファサード経由でもネイティブ存在時はデグラデーションしない（ネイティブ優先）
8. **コンテキスト使用量の正規化**: `OnDeviceSession` の `contextUsage` / `contextWindow` は正規化済みセッション経由で読めるようになり、`reportContextUsage()` と ContextMeter の表示は変更不要であることを確認する
9. **コンパクションのデグラデーション**: レガシー環境では `Summarizer` / `LanguageDetector` グローバルも存在しない可能性が高く、`session.compact()` が失敗し得る。既存の `compact()` は失敗を catch して会話を継続する設計のため追加対応は不要（要テスト観察、警告ログに留める）
10. **テスト追加**: 既存の `installPromptApiStub` に倣い `chrome.aiOriginTrial.languageModel` と `window.ai.languageModel` の両方を差し込めるスタブを追加し、§5 のシナリオを `tests/extension/promptApiBackend.test.ts` に実装する。既存テストは全て非回帰で通ること

## 4. 作業分解と依存関係（並列実装計画）

- **編成**: 直列実施（変更は `extension/sidepanel/services/` とそのテストの単一領域に閉じ、同一パッケージ・同一テストランナーで検証するため WU 間の並列化は不可。WU 間は直列依存チェーンとする）
- **クリティカルパス**: `WU-1 → WU-2 → WU-3`

### WU-1: Prompt API 互換アダプタ

- **所有ファイル**: `extension/sidepanel/services/promptApiCompat.ts`（新規）
- **依存**: なし
- **担当センサー**: `npm run typecheck`
- **内容**: `chrome.aiOriginTrial.languageModel` → `window.ai.languageModel` の順でレガシーファクトリを検出する走査関数と、検出したファクトリを `LanguageModel` 互換ファサードへ正規化する層（`availability`/`create`/`params` の正規化、`capabilities()` フォールバック、セッションプロパティ名の正規化 Proxy）、冪等な `ensurePromptApiShim()`・`isLegacyPromptApi()` を export する。モジュール評価時にも検出できればシムを適用する

### WU-2: オンデバイスバックエンド統合

- **所有ファイル**: `extension/sidepanel/services/promptApiBackend.ts`
- **依存**: WU-1（`ensurePromptApiShim` / `isLegacyPromptApi` / side-effect import を利用する）
- **担当センサー**: `npm run typecheck && npm run test:unit`
- **内容**: `promptApiCompat.js` を `easy-language-model` より前に import。`isPromptApiSupported()` の拡張、`effectivePromptApiTools()` によるツール非対応レガシー環境でのデグラデーション（3箇所の `toPromptApiTools(request.tools)` 呼び出し置き換えと初回警告）

### WU-3: ユニットテスト

- **所有ファイル**: `tests/extension/promptApiBackend.test.ts`
- **依存**: WU-2（テスト対象の新規 export とデグラデーション動作が必要）
- **担当センサー**: `npm run typecheck && npm run test:unit`
- **内容**: `chrome.aiOriginTrial.languageModel` / `window.ai.languageModel` 両方を差し込めるスタブ、検出優先順位・セッション作成・デグラデーション・プロパティ正規化・ネイティブ優先（非上書き）の各テスト。アンインストール時に `globalThis.chrome.aiOriginTrial`・`globalThis.ai` とシムで入れた `LanguageModel` の全てを削除する

```aidlc-graph
{
  "mode": "serial",
  "scope": "standard",
  "reviewers": ["blackhat", "typist"],
  "workUnits": [
    {
      "id": "WU-1",
      "name": "Prompt API 互換アダプタ",
      "files": ["extension/sidepanel/services/promptApiCompat.ts"],
      "dependsOn": [],
      "sensor": "npm run typecheck"
    },
    {
      "id": "WU-2",
      "name": "オンデバイスバックエンド統合",
      "files": ["extension/sidepanel/services/promptApiBackend.ts"],
      "dependsOn": ["WU-1"],
      "sensor": "npm run typecheck && npm run test:unit"
    },
    {
      "id": "WU-3",
      "name": "ユニットテスト",
      "files": ["tests/extension/promptApiBackend.test.ts"],
      "dependsOn": ["WU-2"],
      "sensor": "npm run typecheck && npm run test:unit"
    }
  ]
}
```

## 5. 検証計画（テストシナリオ）

- **追加・更新するテストファイル**: `tests/extension/promptApiBackend.test.ts`
- **正常系**:
  - `chrome.aiOriginTrial.languageModel` のみ存在（`LanguageModel`・`window.ai` なし）する状態で `isPromptApiSupported()` が `true` を返し、`sendOnDeviceChat` のテキスト会話ターンが `text` を返す
  - `window.ai.languageModel` のみ存在する状態でも同様に検出・テキスト会話が成立する
  - 旧式 `capabilities()` のみを持つレガシースタブで、`readily`→セッション作成成功、`after-download`→`prepareOnDeviceModel()` が `downloadprogress` モニタ経由の作成を試みる、`no`→「unavailable」系の `UserFacingError`
  - セッションが旧名 `inputUsage`/`inputQuota` のみを持つ場合、`onContextUsage` に `{ used, window }` が正規化されて届く
- **異常系・境界値**:
  - `chrome.aiOriginTrial.languageModel` と `window.ai.languageModel` が両方存在する場合、`chrome.aiOriginTrial` 側のファクトリが選ばれる（どちらの `create`/`availability` が呼ばれたかで検証）
  - レガシー環境かつ `LanguageModelToolCall` 等なしで `tools` 付きリクエストを送っても例外を投げず、セッション作成オプションに `tools` が含まれず、応答の `functionCalls` が空（テキスト会話のみ）
  - レガシー環境かつツールクラスが存在する場合は、ツール宣言がセッションへ渡る（ツール対応レガシービルドの経路が維持される）
  - ネイティブ `LanguageModel` とレガシー名前空間が両方存在する場合、ネイティブが優先され `globalThis.LanguageModel` が上書きされない（スタブオブジェクトの同一性で検証）
  - ネイティブ `LanguageModel` 存在・ツールクラスなしの従来ケースは、引き続き `UserFacingError`（フラグ案内メッセージ）が投げられる
  - シム適用後にアンインストールし別名前空間で再スタブしても `ensurePromptApiShim()` が冪等に再適用される（テスト間のグローバル汚染がないこと）

## 6. 実行すべきセンサーコマンド

- `npm run typecheck`
- `npm run test:unit`

## 7. スコープ外（やってはいけないこと）

- `server/`（ローカルサーババックエンド）・`shared/systemPrompt.ts`・content script・ツール権限フロー（`toolPermissions.ts` 等）への一切の変更。ツール実行・権限プロンプト・スポットライティングの既存ロジックはレガシー経路でも触れない（デグラデーション時はツール自体が宣言されないため自然に不活化される）
- `Summarizer` / `LanguageDetector` のレガシー名前空間（`ai.summarizer` / `aiOriginTrial.summarizer` 等）へのシム追加。`compact()` は既に失敗を許容する設計であり、コンテキスト溢れ時の要約圧縮が動かないだけで会話は継続する
- `window.ai.assistant` 等、`ai.languageModel` 系よりさらに古い名前空間や、上記2名前空間以外の検出対象の追加
- `easy-language-model` パッケージ自体の変更・fork・新規依存の追加（アダプタ層はリポジトリ内で完結させる）
- `LanguageModelToolCall` 等のクラスのポリフィル。ツール呼び出しの代替実装（JSON モードでの疑似的な function calling 等）は行わない
- `README.md`・スクリーンショット・`docs/` の更新（動作要件ではないため最小差分を維持する）
- `extension/manifest.json`・esbuild 設定の変更

## 8. 補足設計（任意）

- **ユーザーストーリー**: `LanguageModel` グローバルを持たない Chrome ビルド（旧 Origin Trial 期の `chrome.aiOriginTrial.languageModel` または `window.ai.languageModel` のみ）のユーザーが、Settings → Model → On-device model を有効にしたとき、サーバなし・API キーなしでサイドパネルとテキスト会話できる。ページに WebMCP ツールがあってもツール呼び出し API が無ければエラーで止まらず、テキストのみの応答が返る
- **受入条件**:
  - いずれかのレガシー名前空間のみ存在する環境で On-device model トグルが表示・有効化でき、テキスト会話が成立する
  - 両名前空間が存在する場合は `chrome.aiOriginTrial.languageModel` が優先される
  - ツール非対応のレガシー環境で `tools` 付きリクエストが例外なくテキスト応答を返す
  - ネイティブ `LanguageModel` 環境の既存テストが全て非回帰で通る（ツール呼び出し・履歴リプレイ・コンパクション含む）
- **ドメイン/コンポーネントモデル**: `App.tsx → chatBridge → promptApiBackend → (promptApiCompat shim → globalThis.LanguageModel) → EasyLanguageModel → ブラウザの Prompt API`。アダプタは `promptApiBackend` と `easy-language-model` の間にグローバルシムとして介在し、既存のセッション管理・ターン機構・エージェントループは無変更
- **検出順序の根拠**: side panel は拡張機能コンテキストであり、`chrome.aiOriginTrial.*` は拡張機能向けに露出された正規の名前空間であるため先に走査する。`window.ai.languageModel` は通常 Web ページ向けだが、拡張機能コンテキストで同時に存在し得るため第2候補とする。両方存在する場合に同一実装を指すかはブラウザ依存だが、どちらを選んでもファサードが正規化するため実害はなく、順序は deterministic に固定する
- **設計上の不確実性と対処**:
  - `node_modules` 未インストールのため `easy-language-model@0.2.6` が `LanguageModel` グローバルをいつ参照するか（モジュール評価時か呼び出し時か）は未検証。import 順序による評価時シム＋`isPromptApiSupported()` 経由の遅延シムの二重構えで双方をカバーする。実装開始時に `npm install` 後、パッケージの参照タイミングを確認し、モジュール評価時捕捉かつファサードの要求形状と異なる場合は本設計を再検討すること
  - 各レガシー名前空間が現行 API をほぼ鏡像した時期のものか、`capabilities()` しか持たない古い形かはブラウザ・名前空間依存。ファサードは両形を吸収する責務を持ち、名前空間ごとの差分は走査の結果得られたファクトリ1つに閉じる（選択後の正規化は共通）
  - `compact()` が内部で使う `Summarizer`/`LanguageDetector` やセッション `clone()` がレガシー環境に無い可能性がある。いずれも失敗時は既存の catch が会話継続を保証するため、フェイルソフトのままとする（実装時に警告ログを確認）
  - テストでは両名前空間を独立にモックできること、`chrome` グローバル差し込みが `@types/chrome` のテスト内既存スタブと衝突しないことを確認する（`Record<string, unknown>` キャストで吸収）
- **監査観点の選定理由**: グローバルシムの導入・複数名前空間の検出優先順位は信頼境界（ページ側ツールへの到達可否、およびどの API 面に処理を委ねるか）に関わるため `blackhat`、ambient グローバル・型ガード・Proxy・ファサード型の厳密性が本変更の中核のため `typist` を宣言する。DB・クエリ・大規模データの性能面が存在しないため `dbinfra` は対象外と判断した

## 9. 学習ルール

- なし（`docs/aidlc/rules.md` は存在しない）
