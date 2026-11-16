# pi-mem0

Memória de longo prazo para o [pi](https://pi.dev), em cima do [Mem0 OSS](https://github.com/mem0ai/mem0) (`mem0ai` 3.3.1), rodando local.

- **Captura automática por tarefa.** Quando uma tarefa termina, a extensão junta o seu pedido, a resposta final, as notas intermediárias curtas e os arquivos alterados. Isso vai para uma fila em disco, e o Mem0 extrai fatos em segundo plano. Resultados de ferramentas e raciocínio interno não são enviados. Credenciais são removidas antes do envio.
- **Busca só quando você pede.** Nada é injetado no contexto sozinho. O modelo ganha a ferramenta `mem0_memory` com a orientação de buscar só quando você pedir ("procure o que decidimos sobre X"). O `/mem0 search` mostra os resultados só para você.
- **A extração usa qualquer modelo do pi.** A chamada sai pelo registro de modelos do pi (`extractionModel: "provider/modelId"`), com a autenticação que o pi já tem.
- **Separação por projeto.** O projeto é a raiz git mais próxima, e as subpastas compartilham a memória. A busca pode ser no projeto (padrão) ou em todos.
- **Tudo local por padrão.** Os dados ficam em SQLite em `~/.pi/agent/mem0/`, os embeddings vêm do Ollama local (`nomic-embed-text`) e a telemetria do Mem0 fica desligada.

## Instalação

Requisitos: Node 22.19+, pi e Ollama.

```bash
ollama pull nomic-embed-text
pi install npm:@lincolness/pi-mem0
```

Depois, em `~/.pi/agent/settings.json`, escolha o modelo de extração:

```json
{
  "mem0": {
    "extractionModel": "openai/gpt-5.4"
  }
}
```

Para usar uma cópia local (desenvolvimento), rode `npm install` na pasta e aponte `"extensions": ["/caminho/para/pi-mem0"]` em vez do `pi install`.

`extractionModel` usa o mesmo formato do `--model` do pi (`provider/id`; veja `pi --list-models`). Sem ele, a extração usa o modelo da sessão. Prefira um modelo capaz: a extração exige JSON e não ocupa o contexto do agente.

Se o `npm install` avisar que bloqueou o script do `better-sqlite3` e a extensão reclamar do SQLite, rode `npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3`.

## Uso

### Sem fazer nada

Quando uma tarefa termina, a extensão salva sozinha os fatos importantes dela: decisões, causas de bugs e convenções. A barra de status mostra `mem0: salvando…` e depois `mem0: on`.

### Pedindo no chat

O modelo só consulta a memória quando você pede:

- "procure na memória o que decidimos sobre o arredondamento"
- "busca em todos os projetos como resolvemos o timeout do banco"
- "lembre que neste projeto usamos node:test"

Os resultados entram na conversa e o modelo usa isso para responder.

### Slash commands

Os resultados aparecem só para você e não entram no contexto do modelo.

| Comando | O que faz |
|---|---|
| `/mem0 status` | Mostra o projeto atual, o modelo de extração, a fila pendente e onde estão os dados |
| `/mem0 search <texto>` | Busca no projeto atual |
| `/mem0 search-all <texto>` | Busca em todos os projetos |
| `/mem0 list` | Lista as memórias mais recentes do projeto |
| `/mem0 add <texto>` | Guarda o texto exatamente como você escreveu |
| `/mem0 delete <id>` | Apaga uma memória (o id aparece no `search` e no `list`) |
| `/mem0 flush` | Reprocessa o que ficou na fila (útil se a extração falhou) |

O projeto é a raiz git mais próxima de onde você abriu o pi, então as subpastas compartilham a mesma memória.

Para começar, faça uma tarefa normal, rode `/mem0 list` para ver o que foi salvo e apague com `/mem0 delete` o que não servir.

### Fila

A barra de status mostra `mem0: on`, `mem0: salvando…` ou `mem0: N pendente(s)`. Se você fechar o pi antes de a extração terminar, a tarefa continua na fila e é processada na próxima sessão. Depois de 5 falhas, ela vai para `outbox-failed/`.

## Configuração (`"mem0"` no settings)

| Campo | Padrão | O que faz |
|---|---|---|
| `enabled` | `true` | Liga ou desliga a extensão |
| `extractionModel` | modelo da sessão | Modelo do pi para extrair fatos (`provider/id`) |
| `extractionReasoning` | `"low"` | Nível de raciocínio da extração, ou `"off"` |
| `extractionTimeoutMs` | `120000` | Tempo máximo de cada extração |
| `embedder` | Ollama `nomic-embed-text` | Embedder do Mem0 `{provider, config}`; veja abaixo |
| `vectorStore` | SQLite em `dataDir` | Qualquer vector store do Mem0 (qdrant, pgvector…) |
| `dataDir` | `~/.pi/agent/mem0` | Onde ficam banco, histórico e fila |
| `userId` | `$USER` | Dono das memórias |
| `customInstructions` | — | Instruções extras para o extrator (o que guardar, idioma) |
| `capture.enabled` | `true` | Captura automática |
| `capture.includeIntermediate` | `true` | Inclui as notas curtas entre ferramentas |
| `capture.maxChars` | `12000` | Limite de texto enviado por tarefa |
| `capture.minChars` | `80` | Ignora conversas muito curtas (a menos que alterem arquivos) |
| `search.defaultLimit` / `search.maxLimit` | `5` / `20` | Quantidade de resultados |
| `telemetry` | `false` | Telemetria do Mem0 (PostHog) |

Para usar um embedder de outro provider (por exemplo, o endpoint OpenAI do trabalho), há duas formas de passar a chave:

```json
"embedder": { "provider": "openai", "config": { "model": "text-embedding-3-small" }, "piProvider": "openai" }
```

`piProvider` reaproveita a chave e a URL de um provider do pi. Outra opção é `"apiKeyEnv": "NOME_DA_VARIAVEL"`. Trocar de modelo de embedding exige um `dataDir` novo, porque as dimensões dos vetores mudam.

## Testes

```bash
npm test
```

O teste de integração (`tests/store.integration.test.ts`) roda o Mem0 de verdade, com SQLite e Ollama, e um extrator falso. Ele é pulado se o Ollama ou o `nomic-embed-text` não estiverem disponíveis.
