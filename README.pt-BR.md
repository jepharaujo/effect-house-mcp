# effect-house-mcp

[English](README.md) · **Português**

Servidor MCP (Model Context Protocol) **não oficial** que conecta Claude Code, Codex e qualquer outro cliente MCP ao
**TikTok Effect House**, para criar e editar efeitos por conversa a partir das suas próprias sessões de IA.

> Não é afiliado ao TikTok nem endossado por ele. Usa interfaces internas e não documentadas do Effect House 5.16, que
> podem mudar em qualquer atualização do app. Effect House e TikTok são marcas de seus respectivos donos.

## Por que ele existe

Desde a versão 5.16, o Effect House traz um assistente de IA (painel **Effect House AI**) que abre Claude Code, Codex
ou Cursor dentro do próprio app. Por baixo, ele usa dois componentes locais que este projeto reaproveita:

- **Kernel `eh`** (`Contents/MacOS/eh_front`): servidor MCP por stdio com a ferramenta `run`, que executa células de
  JavaScript com uma API `eh` já conectada ao editor (cena, scripts APJS, assets, preview, screenshots, plano). Ele
  procura o editor sozinho a cada célula, então sobrevive a reinícios do app.
- **Servidor de automação** (HTTP em `127.0.0.1`, porta anunciada em
  `~/Library/Application Support/EffectHouse/Instances/*/MCP/mcp_port.json`): 33 ferramentas de alto nível
  (`get_scene`, `edit_by_dsl`, `capture_preview`, `generate_image`…).

A documentação oficial só cobre o uso pelo painel, que roda um agente por vez dentro do app. Esta ponte deixa você usar
esses recursos de fora: das suas sessões, com suas skills, memórias e outros MCPs (Blender, geração de imagem etc.).

## O que a ponte acrescenta

| Ferramenta | O que faz |
| --- | --- |
| `run`, `reset`, `status` | Kernel `eh` oficial, repassado sem alterações (textos, imagens e erros). |
| `instances` | Instalação e versão do app, editores abertos (porta, heartbeat, saúde), projeto aberto, estado do kernel e pasta do workspace. |
| `launch` | Abre o Effect House (opcionalmente com um projeto) e espera o servidor responder. Não abre um segundo editor. |
| `docs_search`, `docs_read` | Busca e leitura da documentação oficial em [effecthouse.tiktok.com/learn](https://effecthouse.tiktok.com/learn/) (todas as páginas do sitemap), convertida em Markdown e guardada em cache. |
| `workspace_read` | Lê as referências do kernel (skills, declarações APJS, fluxos de planejamento) para clientes que não leem arquivos locais. |
| Ferramentas de automação | Opcionais (`EH_MCP_AUTOMATION_TOOLS=1`): as 33 ferramentas HTTP expostas diretamente. Desligadas por padrão porque somam ~70 KB de definições e o kernel já as alcança. |

Além disso, a ponte:

- lê o guia oficial do workspace (`AGENTS.md`) da versão instalada e o entrega como `instructions` do servidor MCP;
- mantém uma cópia própria do workspace do kernel em `~/Library/Application Support/effect-house-mcp/workspace`,
  sem os arquivos de configuração de agentes do app, e a renova quando o Effect House é atualizado;
- reinicia o kernel se ele cair e avisa que os valores de `session` foram perdidos;
- recusa `run` com uma mensagem clara quando o Effect House não está aberto.

## Requisitos

- macOS (testado no Apple Silicon). Outros sistemas exigem as variáveis de ambiente abaixo e não foram testados.
- Effect House **5.16 ou mais recente**, instalado e com login feito.
- Node.js 20 ou mais recente.

## Instalação

```bash
git clone https://github.com/jepharaujo/effect-house-mcp.git
cd effect-house-mcp
npm ci
npm run build
npm run doctor
```

O `doctor` mostra o que a ponte encontrou: app, versão, instâncias abertas e workspace. Ele sai com código 1 se faltar
algo essencial.

### Claude Code

Rode dentro da pasta do projeto (os caminhos absolutos do Node e do servidor ficam gravados no registro):

```bash
claude mcp add effect-house -s user -- "$(which node)" "$(pwd)/dist/src/index.js"
```

Uma célula pode levar até 10 minutos (montar cena, script e playtest numa chamada só). Se o Claude Code encerrar
chamadas longas antes disso, aumente o limite com a variável `MCP_TOOL_TIMEOUT=660000`.

### Codex

Em `~/.codex/config.toml`, com os caminhos da sua máquina (`which node` e a pasta do projeto):

```toml
[mcp_servers.effect-house]
command = "/opt/homebrew/bin/node"
args = ["/caminho/para/effect-house-mcp/dist/src/index.js"]
startup_timeout_sec = 30
# Uma célula pode durar até o limite de 10 minutos do kernel.
tool_timeout_sec = 660
```

### Outros clientes

Qualquer cliente MCP por stdio: comando `node`, argumento `dist/src/index.js`. Apps com interface gráfica costumam
precisar do caminho absoluto do Node.

## Como usar

Com o Effect House aberto, peça ao agente algo como “abre um projeto novo e cria um efeito de sardas no rosto”. O
agente segue o guia oficial: confere o projeto com `eh.project.status()`, preenche e valida um plano
(`eh.plan.fromTemplate` / `eh.plan.validate`), constrói a cena e verifica com capturas do preview.

Exemplo de célula para o `run`:

```js
const status = await eh.project.status();
const scene = await eh.scene.getScene();
return { status, scene };
```

`help()` dentro de uma célula lista toda a API (`help('scene')`, `help('EHObject')`, `help('preview.screenshot')`).

## Cuidados

- O agente edita **o projeto aberto, ao vivo**, sem sandbox. Salve antes de mudanças grandes.
- Use um agente por vez: não rode o painel Effect House AI e esta ponte no mesmo projeto ao mesmo tempo.
- Capturas do preview vão para o provedor de IA do seu cliente, como qualquer imagem que o agente lê.
- O Effect House exige um plano validado antes de construir cena; essa regra vem do kernel oficial e a ponte a respeita.
- `docs_read` só busca páginas de `effecthouse.tiktok.com/learn/`; a ponte só conversa com o editor em `127.0.0.1`.

## Variáveis de ambiente

| Variável | Uso |
| --- | --- |
| `EH_APP_PATH` | Caminho do app (padrão: `/Applications/Effect House.app`, ou o que o próprio app registrou em `app.json`). |
| `EH_EXECUTABLE_DIR`, `EH_FRONT_PATH`, `EH_WORKSPACE_TEMPLATE`, `EH_SUPPORT_DIR` | Caminhos individuais, para instalações fora do padrão ou outros sistemas. |
| `EH_PROJECT` | Prende o kernel ao editor que estiver com este projeto aberto (útil com vários editores). |
| `EH_MCP_AUTOMATION_TOOLS=1` | Expõe também as ferramentas de automação do editor. |
| `EH_MCP_STATE_DIR`, `EH_MCP_CACHE_DIR` | Onde ficam a cópia do workspace e o cache da documentação. |
| `EH_MCP_LOG_LEVEL` | `debug`, `info` (padrão), `warn` ou `error`; os logs vão para o stderr. |

## Arquitetura

```text
cliente MCP (Claude Code, Codex…)
        │ stdio
        ▼
effect-house-mcp ──────────────► docs: effecthouse.tiktok.com/learn (sitemap + cache)
   │        │
   │ stdio  │ HTTP (127.0.0.1, porta do registro de instâncias)
   ▼        ▼
eh_front ─► kernel eh ─────────► servidor de automação do Effect House ─► editor aberto
```

| Arquivo | Responsabilidade |
| --- | --- |
| `src/index.ts` | Ponto de entrada e CLI (`serve`, `doctor`, `index-docs`). |
| `src/server.ts` | Servidor MCP: lista e roteia ferramentas, ferramentas próprias. |
| `src/kernel.ts` | Cliente do `eh_front`: início sob demanda, reinício, stderr para diagnóstico. |
| `src/automation.ts` | Cliente do servidor HTTP do editor; só repete uma chamada se a conexão foi recusada. |
| `src/registry.ts` | Leitura do registro de instâncias, heartbeat e health check. |
| `src/workspace.ts` | Cópia do workspace, instruções do servidor e `workspace_read` (sem sair da pasta). |
| `src/docs.ts`, `src/html.ts` | Sitemap, busca, cache e conversão HTML → Markdown da documentação. |
| `src/toolcache.ts` | Guarda a lista de ferramentas do kernel por versão, para não iniciar o kernel só para listar. |

## Desenvolvimento

```bash
npm run check        # lint (Biome), tipos e testes unitários
npm run smoke        # teste ao vivo, só leitura, com o Effect House aberto (rode npm run build antes)
npm run docs:index   # baixa todas as páginas da documentação para busca em texto completo
```

Os testes unitários não precisam do Effect House. O `smoke` sobe a ponte como um cliente MCP faria e chama cada família
de ferramentas.

Testado com Effect House 5.16.0 no macOS (Apple Silicon), Node.js 25 e Claude Code. Issues e pull requests são bem-vindos,
principalmente com relatos de outras versões do Effect House.

## Problemas comuns

- **“Effect House is not open”**: abra o app ou chame `launch`; confira com `instances`.
- **O kernel não inicia**: `npm run doctor` deve mostrar `ehFrontExists: true`. Versões anteriores à 5.16 não têm o kernel.
- **Vários editores abertos**: defina `EH_PROJECT` com a pasta do projeto que o agente deve usar.
- **Busca da documentação só por URL**: o texto completo entra no índice conforme as páginas são lidas, ou de uma vez
  com `npm run docs:index`.

## Licença

[MIT](LICENSE).
