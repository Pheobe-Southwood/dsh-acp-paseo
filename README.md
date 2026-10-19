# dsh-acp-paseo

**DeepSeek Harness in Paseo.** Add the DSH bundle and the Paseo plugin from npm,
then use DSH models, tools, reasoning, questions and one-shot approvals inside
Paseo's normal chat UI.

[English](#english) · [中文](#中文) · [日本語](#日本語) · [Français](#français) · [한국어](#한국어)

npm: [@ds-hu/dsh-acp-paseo](https://www.npmjs.com/package/@ds-hu/dsh-acp-paseo) · [@ds-hu/dsh-acp-plus](https://www.npmjs.com/package/@ds-hu/dsh-acp-plus)

## English

### What you get

- **DeepSeek Harness** joins Paseo's provider list, and the models from your DSH profile appear automatically.
- Tool calls, reasoning, diffs and token usage use Paseo's normal timeline.
- DSH questions become native Paseo cards. Tool approvals apply to one action only.
- Sessions keep their DSH session id, so they reopen after a reload.
- Paseo Web, Desktop and mobile all drive the same daemon.

![DeepSeek Harness models in Paseo](docs/images/provider-models.png)

*The models exposed by the DSH profile are ready to pick.*

### How to use

1. Create the DSH `acp-plus` profile once, then add the npm bundle:

   ```bash
   dsh plugin --profile acp-plus add @ds-hu/dsh-acp-plus
   ```

2. Install the Paseo plugin from npm:

   ```bash
   paseo plugin install npm:@ds-hu/dsh-acp-paseo
   ```

3. Add the provider entry under `agents.providers` in `~/.paseo/config.json`:

   ```json
   "deepseek-harness": { "command": ["dsh", "--profile", "acp-plus"] }
   ```

4. Enable the plugin in **Settings → Plugins**, then choose **DeepSeek Harness** in a new agent.

The `acp-plus` profile is a one-time setup. The exact profile, build commands
and test matrix are in the [technical guide](docs/TECHNICAL.md).

![A DSH turn in Paseo](docs/images/chat.png)

*A real turn: shell tool call, reasoning, answer, token usage and session controls.*

![Native DSH question card](docs/images/questions.png)

*DSH asks, and Paseo shows its own card with options, free text and Submit.*

![One-shot tool approval](docs/images/permissions.png)

*A command outside the workspace waits for approval. Allow once, or reject and keep the workspace unchanged.*

---

## 中文

### 带来什么

- Paseo 的 Provider 列表新增 **DeepSeek Harness**，DSH profile 里的模型会自动出现。
- 工具调用、思考过程、Diff 和 Token 用量直接进入 Paseo 原有时间线。
- DSH 的提问变成 Paseo 原生问题卡片；工具审批只对当前操作生效。
- 会话保留 DSH 的 session id，刷新页面后可以接着聊。
- Paseo 网页版、桌面版和手机版共用同一个 daemon。

![Paseo 中的 DeepSeek Harness 模型](docs/images/provider-models.png)

*插件安装后自动发现 DSH profile 提供的模型，直接在选择器里使用。*

### 怎么用

1. 按[技术文档](docs/TECHNICAL.md)创建一次 DSH 的 `acp-plus` profile，然后加入 npm 包：

   ```bash
   dsh plugin --profile acp-plus add @ds-hu/dsh-acp-plus
   ```

2. 从 npm 安装 Paseo 插件：

   ```bash
   paseo plugin install npm:@ds-hu/dsh-acp-paseo
   ```

3. 在 `~/.paseo/config.json` 的 `agents.providers` 下加入：

   ```json
   "deepseek-harness": { "command": ["dsh", "--profile", "acp-plus"] }
   ```

4. 打开 **Settings → Plugins** 启用插件，新建 Agent 时选择 **DeepSeek Harness**。

`acp-plus` profile 只需配置一次，完整步骤见[技术文档](docs/TECHNICAL.md)。

![Paseo 中的一次 DSH 对话](docs/images/chat.png)

*真实对话：Shell 工具调用、思考过程、回答、Token 用量和会话控制都在同一屏。*

![DSH 原生问题卡片](docs/images/questions.png)

*DSH 发起提问，Paseo 用原生卡片展示选项、自由输入和提交按钮。*

![一次性工具审批](docs/images/permissions.png)

*工作区之外的命令会等待审批。允许一次，或者拒绝并保持工作区不变。*

---

## 日本語

### できること

- Paseo のプロバイダー一覧に **DeepSeek Harness** が加わり、DSH プロファイルのモデルが自動で見つかります。
- ツール呼び出し、思考、差分、トークン使用量は Paseo のタイムラインにそのまま表示されます。
- DSH の質問は Paseo の質問カードになり、ツール承認は1回の操作だけに適用されます。
- セッションは DSH の session id を保持し、再読み込み後も続きから使えます。
- Paseo の Web、デスクトップ、モバイルは同じ daemon につながります。

![Paseo の DeepSeek Harness モデル](docs/images/provider-models.png)

*プロバイダーを追加すると DSH プロファイルのモデルが見つかり、そのまま選べます。*

### 使い方

1. [技術ガイド](docs/TECHNICAL.md)の手順で DSH の `acp-plus` プロファイルを一度作成し、npm パッケージを追加します:

   ```bash
   dsh plugin --profile acp-plus add @ds-hu/dsh-acp-plus
   ```

2. npm から Paseo プラグインをインストールします:

   ```bash
   paseo plugin install npm:@ds-hu/dsh-acp-paseo
   ```

3. `~/.paseo/config.json` の `agents.providers` に追加します:

   ```json
   "deepseek-harness": { "command": ["dsh", "--profile", "acp-plus"] }
   ```

4. **Settings → Plugins** で有効にし、新しい Agent で **DeepSeek Harness** を選びます。

`acp-plus` プロファイルの作成は初回のみです。詳細は[技術ガイド](docs/TECHNICAL.md)にあります。

![Paseo での DSH の会話](docs/images/chat.png)

*実際の会話: シェルツール、思考、回答、トークン使用量、セッション操作が1画面に収まります。*

![DSH の質問カード](docs/images/questions.png)

*DSH の質問を Paseo のカードで表示し、選択肢、自由入力、送信をそのまま使えます。*

![1回限りのツール承認](docs/images/permissions.png)

*ワークスペース外のコマンドは承認待ちになります。1回だけ許可するか、拒否して変更を残さないかを選べます。*

---

## Français

### Ce que vous obtenez

- **DeepSeek Harness** rejoint la liste des fournisseurs Paseo, et les modèles de votre profil DSH sont détectés automatiquement.
- Les appels d'outils, le raisonnement, les diffs et l'usage des tokens restent dans la timeline habituelle de Paseo.
- Les questions DSH deviennent des cartes Paseo. Les approbations d'outils valent pour une seule action.
- Les sessions gardent leur identifiant DSH et reprennent après un rechargement.
- Paseo Web, Desktop et mobile utilisent le même daemon.

![Modèles DeepSeek Harness dans Paseo](docs/images/provider-models.png)

*Les modèles exposés par le profil DSH sont prêts à être choisis.*

### Utilisation

1. Créez une fois le profil DSH `acp-plus` (voir le [guide technique](docs/TECHNICAL.md)), puis ajoutez le paquet npm :

   ```bash
   dsh plugin --profile acp-plus add @ds-hu/dsh-acp-plus
   ```

2. Installez le plugin Paseo depuis npm :

   ```bash
   paseo plugin install npm:@ds-hu/dsh-acp-paseo
   ```

3. Ajoutez l'entrée sous `agents.providers` dans `~/.paseo/config.json` :

   ```json
   "deepseek-harness": { "command": ["dsh", "--profile", "acp-plus"] }
   ```

4. Activez le plugin dans **Settings → Plugins**, puis choisissez **DeepSeek Harness** dans un nouvel agent.

Le profil `acp-plus` se configure une fois. Le profil complet, les commandes
de build et la matrice de tests sont dans le [guide technique](docs/TECHNICAL.md).

![Une conversation DSH dans Paseo](docs/images/chat.png)

*Une conversation réelle : appel shell, raisonnement, réponse, usage des tokens et contrôles de session.*

![Carte de question DSH](docs/images/questions.png)

*DSH pose une question ; Paseo affiche sa carte avec options, texte libre et validation.*

![Approbation d'outil unique](docs/images/permissions.png)

*Une commande hors du workspace attend une approbation. Autorisez une fois, ou refusez sans modifier le workspace.*

---

## 한국어

### 제공하는 것

- Paseo 공급자 목록에 **DeepSeek Harness**가 추가되고 DSH 프로필의 모델이 자동으로 검색됩니다.
- 도구 호출, 사고 과정, diff, 토큰 사용량이 Paseo의 기존 타임라인에 그대로 표시됩니다.
- DSH의 질문은 Paseo 질문 카드로 표시되고, 도구 승인은 한 번의 작업에만 적용됩니다.
- 세션은 DSH session id를 유지하므로 새로고침 후에도 이어서 사용할 수 있습니다.
- Paseo Web, 데스크톱, 모바일은 같은 daemon을 사용합니다.

![Paseo의 DeepSeek Harness 모델](docs/images/provider-models.png)

*공급자를 추가하면 DSH 프로필의 모델이 자동으로 검색되어 바로 선택할 수 있습니다.*

### 사용 방법

1. [기술 문서](docs/TECHNICAL.md)의 절차로 DSH `acp-plus` 프로필을 한 번 만든 뒤 npm 패키지를 추가합니다:

   ```bash
   dsh plugin --profile acp-plus add @ds-hu/dsh-acp-plus
   ```

2. npm에서 Paseo 플러그인을 설치합니다:

   ```bash
   paseo plugin install npm:@ds-hu/dsh-acp-paseo
   ```

3. `~/.paseo/config.json`의 `agents.providers`에 항목을 추가합니다:

   ```json
   "deepseek-harness": { "command": ["dsh", "--profile", "acp-plus"] }
   ```

4. **Settings → Plugins**에서 플러그인을 켜고 새 Agent에서 **DeepSeek Harness**를 선택합니다.

`acp-plus` 프로필은 한 번만 설정하면 됩니다. 전체 절차와 빌드, 테스트
방법은 [기술 문서](docs/TECHNICAL.md)에 있습니다.

![Paseo에서의 DSH 대화](docs/images/chat.png)

*실제 대화: 셸 도구 호출, 사고 과정, 답변, 토큰 사용량, 세션 제어가 한 화면에 표시됩니다.*

![DSH 질문 카드](docs/images/questions.png)

*DSH가 질문하면 Paseo 카드에서 선택지, 직접 입력, 제출을 그대로 사용할 수 있습니다.*

![일회성 도구 승인](docs/images/permissions.png)

*작업 공간 밖의 명령은 승인을 기다립니다. 한 번만 허용하거나 거부해 작업 공간을 그대로 둘 수 있습니다.*

---

## Technical details

Build steps, profile setup, the test matrix and design records:
[docs/TECHNICAL.md](docs/TECHNICAL.md).

MIT licensed. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
