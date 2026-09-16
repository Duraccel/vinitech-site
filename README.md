# Negan — Vini Tech

Módulo de atendimento comercial do Extrator Leads. Primeira versão: explica o produto, compara planos, sugere a menor franquia adequada e conduz ao checkout existente. Nome confirmado: **Negan**.

## Estado desta entrega

Site recuperado da publicação `dpl_Bd2Y71RnuMtdmsRtzcpDWuUnq39i` em 16/09/2026. As seis funções originais do Mercado Pago e o `vercel.json` foram copiados literalmente pelo botão de cópia da Vercel; HTML, estilos e mídia vieram da publicação pública. O Negan foi acrescentado à página institucional e à página do Extrator, preservando rotas, agendamento e pagamentos. Os antigos testes do site não foram recuperados; os testes incluídos cobrem o Negan e a integridade da recuperação.

O servidor usa IA somente quando todas as variáveis abaixo estão configuradas. Sem elas, há respostas guiadas explicitamente identificadas na interface. A integração real com o modelo deve ser validada após configurar credenciais; os testes usam respostas simuladas.

## Integração no projeto completo

1. Copie `assets/negan.js`, `assets/negan.css`, `api/negan.js` e `lib/negan.cjs` para os mesmos caminhos na raiz do projeto existente. Não substitua `vercel.json`, `package.json` nem funções de pagamento.
2. Execute `node scripts/integrate.cjs CAMINHO/extrator-vendas/index.html`. Ele insere `<script src="/assets/negan.js" defer></script>` antes de `</body>` de forma idempotente. Também pode integrar a página institucional com o mesmo comando.
3. O checkout existente usa `.plan-button[data-plan]` com `initial`, `professional` e `advanced`. O Negan aciona o botão correspondente, preservando seleção, valores, formulário e pagamento originais. Nunca inicia uma cobrança.
4. Publique uma prévia do projeto completo. Teste desktop/celular, abertura/fechamento, limites, indisponibilidade de IA e seleção de cada plano antes da publicação final.

## IA e custos

Configure no servidor, nunca no navegador:

- `AI_GATEWAY_API_KEY`: chave do Vercel AI Gateway.
- `NEGAN_MODEL`: identificador de um modelo disponível no Gateway que suporte Chat Completions e `response_format: json_object`; validar na conta antes de ativar.
- `KV_REST_API_URL` e `KV_REST_API_TOKEN`: Redis REST compatível com comandos EVAL, INCR e EXPIRE (como Upstash).
- `NEGAN_RATE_SALT`: segredo aleatório usado para gerar hash dos IPs nos contadores.
- `NEGAN_ALLOWED_ORIGINS`: opcional, origens HTTPS exatas adicionais, separadas por vírgula.

Há limite compartilhado de 30 chamadas de IA por IP por hora; falha no limitador desativa chamadas pagas. O limite por IP não impede abuso distribuído: configurar orçamento do Gateway e proteção/rate limiting na Vercel antes do lançamento. Não existe cobrança fixa presumida para IA. O cliente deve configurar os limites financeiros na sua conta.

Origem é validada contra domínios explícitos e VERCEL_URL. Histórico limitado a 16 mensagens e 10 mil caracteres, respostas até 450 tokens, tempo máximo de IA 20 s. Chaves e mensagens não são registradas pelo código. Conversas ficam apenas em memória na página; nova conversa/recarregar limpa o histórico. Provedor de IA pode ter políticas próprias de processamento/retenção; ajustar a política de privacidade publicada antes de ativar IA real.

Referência: https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions

## Testes e prévia

Node 22 ou superior. Sem dependências externas.

```sh
npm test
npm run preview
```

A prévia requer `preview/index.html` e os estilos do site em `preview/extrator-vendas/assets/` (arquivos locais de referência, não versionados). Integre o widget nesse HTML com o script acima. O servidor abre em http://127.0.0.1:4173. Pagamentos sempre retornam erro explícito na prévia; nenhuma cobrança é realizada. Não use o servidor de prévia como servidor de produção.

## Eventos de conversão

O widget emite eventos locais `negan:event`: `opened`, `answered` (mode) e `plan_clicked` (plan). Não envia conteúdo da conversa, nomes, e-mails nem telefone para analytics. Esses eventos são pontos de integração, não um painel já conectado. Para medir assinaturas, relacionar eventos ao pagamento confirmado na integração existente, após definir a política de atribuição.

## Manutenção

Preços verificados na página pública em 16/09/2026: R$ 37,90/50 pesquisas, R$ 57,90/200, R$ 97,90/500, por mês. Manter `lib/negan.cjs` sincronizado com o checkout sempre que mudar o catálogo. Modelo gera texto probabilístico; verificar que não inventa condições. Links e ações de pagamento não são gerados pelo modelo. Configurar a conta Vercel para o plano compatível com uso comercial.
