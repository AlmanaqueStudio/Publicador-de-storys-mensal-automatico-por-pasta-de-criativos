# Estúdio de Distribuição

Tela de login + painel limpo com as redes sociais que o bot vai automatizar.

## Como abrir

Abra `index.html` no navegador (duplo clique já funciona).

Ou sirva a pasta para evitar qualquer bloqueio de arquivo local:

```bash
cd painel
python -m http.server 8000
# abra http://localhost:8000
```

## Acesso de teste

| campo   | valor          |
|---------|----------------|
| usuário | `admin`        |
| senha   | `VideoBot2026!`|

Para trocar, edite `CREDENCIAIS` no topo do `<script>` em `index.html`.

## Fluxo

1. `index.html` — login. Credenciais confem, grava `sessionStorage` e redireciona.
2. `dashboard.html` — página limpa. Sem sessão, volta para o login.
   Cada rede tem um interruptor "Automatizar"; o estado fica salvo em `localStorage`.

Rede ativa na fila: Business.
No banco (reserva, fora da fila): YouTube, TikTok, Kwai, LinkedIn, X, Pinterest.
Instagram e Facebook foram removidos da lista.
Edite os arrays `REDES` (ativas) e `REDES_BANCO` (reserva) em `dashboard.html`.

## Storys (Facebook/Instagram) — bot local

O dashboard tem uma seção **Storys** que fala com um bot Playwright separado em
[`story-bot/`](../README.md). Ele publica storys reais no Facebook e
Instagram pelo Meta Business Suite, simulando uma pessoa (mouse humanizado,
pausas aleatórias, um story por vez).

Pra essa seção funcionar:

1. `cd .. && npm install && npx playwright install chrome`
2. `npm run setup` — abre um Chrome isolado pra você logar (uma vez) na conta
   que administra a página alvo. Feche a janela quando terminar.
3. `npm run server` — sobe a API local (`localhost:4599`) que o botão
   **"Publicar storys"** do dashboard chama. Precisa estar rodando sempre que
   você for usar esse botão.
4. No dashboard: selecione a mídia, defina início/fim/horário/quantidade por
   dia, clique **"Gerar agenda"** e depois **"Publicar storys"**.

Ao clicar em publicar, você escolhe:

| opção | o que faz |
|---|---|
| **1 — hoje** | publica agora mesmo o story de hoje |
| **2 — 1 semana** | **agenda** (não publica na hora) os próximos 7 dias direto no calendário do Meta, um a um |
| **3 — agenda inteira** | **agenda** todos os storys pendentes, até a data final, direto no calendário do Meta |

Detalhes de configuração, ajuste de seletores da UI do Meta e o aviso sobre
risco de bloqueio (automatizar o Meta é contra os Termos de Uso deles) estão
em [`story-bot/README.md`](../README.md).

## Aviso de segurança

Este login é **apenas front-end** — serve para prototipar a interface. A senha
fica visível no código e qualquer pessoa com o arquivo a vê. Antes de usar de
verdade, mova a autenticação para um backend (sessão/JWT) e nunca deixe chaves
de API no navegador.

## Próximo passo: publicação real

O painel só controla a intenção ("quais redes"). Para publicar de fato você
precisa de um backend que fale com cada API:

| Rede      | API para publicar vídeo                                   |
|-----------|-----------------------------------------------------------|
| YouTube   | YouTube Data API v3 — `videos.insert`                     |
| TikTok    | TikTok Content Posting API                                |
| Instagram | ✅ storys via `story-bot` (browser); Reels por API real = Instagram Graph API (`media` + `media_publish`) |
| Facebook  | ✅ storys via `story-bot` (browser); feed/vídeo por API real = Facebook Graph API |
| LinkedIn  | LinkedIn Marketing API — UGC / Posts com vídeo            |
| Kwai      | Kwai for Business / Open API (acesso sob aprovação)       |
| X         | X API v2 — upload de mídia + post                         |
| Pinterest | Pinterest API — Pins com vídeo                            |

> Facebook/Instagram já publicam storys de verdade hoje, mas via automação de
> navegador (`story-bot`, veja a seção acima) — não pela API oficial da Meta.
> É mais simples de configurar (não precisa de App Review nem OAuth), mas
> viola os Termos de Uso do Meta e tem risco de bloqueio temporário da conta.

Fluxo sugerido do backend:

1. OAuth de cada plataforma → guardar tokens por rede.
2. Endpoint `POST /publicar` recebe o vídeo + legenda + lista de redes ativas.
3. Fila (ex.: BullMQ, Celery) faz upload em paralelo e grava o resultado por rede.
4. O painel consulta o status da fila em vez do `localStorage`.
