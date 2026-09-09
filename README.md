# story-bot

Publica **storys no Facebook + Instagram** pelo Meta Business Suite, **simulando uma pessoa**:
move o mouse, espera intervalos aleatórios, envia **um story por vez** e só passa
para o próximo **depois de detectar a confirmação de envio**.

É um processo Node independente — **não usa Claude** e não fica preso a nenhuma
sessão externa. Você roda quando quiser, ou deixa agendado.

> ⚠️ **Aviso:** automatizar o Meta é contra os Termos de Uso deles. É a sua conta e
> o seu conteúdo, mas há risco de bloqueio temporário. Use com moderação
> (o padrão é 1 story/dia, com pausas aleatórias).

---

## 1. Instalar

```bash
cd story-bot
npm install
npx playwright install chrome
```

## 2. Configurar

Edite `config.json`:

| campo | o que é |
|---|---|
| `calendarUrl` / `homeUrl` | links do Meta Business Suite com o **business_id** e **asset_id** da página alvo (ex.: Debroi Eventos) |
| `mediaDir` | pasta com os vídeos/imagens (padrão `./media`) |
| `schedule.startDate` / `endDate` | `"today"`, `"endOfMonth"` ou `"AAAA-MM-DD"` |
| `schedule.perDay` | quantos storys por dia |
| `schedule.time` | horário (usado pelo `--daemon`) |
| `targets` | publicar no `facebook` e/ou `instagram` |
| `debug` | `true` gera prints de cada passo em `./debug` (use para ajustar `selectors.json`) |

Coloque as mídias em `story-bot/media/` (ou aponte `mediaDir` para outra pasta).

## 3. Login (uma vez)

```bash
npm run setup
```

Abre o Chrome. **Faça login na conta do Facebook que administra a página alvo.**
Quando o Meta Business Suite carregar, feche a janela. A sessão fica salva em
`./chrome-profile` e os próximos comandos já entram logados.

### Por que o bot não usa a mesma aba/sessão do seu Chrome normal

Foi tentado: conectar no seu Chrome já aberto (modo CDP) e até copiar os
cookies de login para o perfil do bot. Nenhum dos dois funciona de verdade
no Chrome atual:

- **Anexar no Chrome padrão (CDP):** desde 2025 o Chrome só abre a porta de
  depuração remota (`--remote-debugging-port`) se o perfil **não** for o
  padrão. Ou seja, dá pra anexar numa janela separada, mas não na mesma
  janela/sessão que você já está usando.
- **Copiar os cookies de login:** o Chrome criptografa os cookies com uma
  chave presa à instalação (App-Bound Encryption) — é uma proteção
  anti-roubo de sessão. Copiar o arquivo de cookies para outra pasta de
  perfil não funciona; o Chrome simplesmente não reconhece o login e manda
  pra tela de login de novo.

Por isso o bot usa um **perfil próprio e isolado** (`./chrome-profile`), com
login manual **uma única vez** via `npm run setup`. Depois disso ele fica
logado sozinho — é o mesmo custo de digitar a senha uma vez, só que numa
janela separada da que você usa no dia a dia (o que também é mais seguro:
suas outras abas nunca ficam expostas ao bot).

Existe um modo `cdp` no `config.json` (desligado por padrão) caso você
prefira controlar manualmente uma janela de depuração — mas ele **não**
herda o login do seu Chrome principal; exige logar de novo dentro dela
mesmo assim, então na prática não traz vantagem sobre o `npm run setup`.

## 4. Gerar a agenda

```bash
npm run plan
```

Lê a pasta de mídias e cria `agenda.json` distribuindo os arquivos de forma
**aleatória e sem repetir muito** (embaralha um "baralho"; ao reembaralhar,
impede que o último vídeo repita em seguida). Mostra a lista e o uso por arquivo.

## 5. Publicar

```bash
npm run run        # só os storys de HOJE, um a um
npm run run:all    # a agenda inteira agora (teste ou colocar em dia)
```

O bot:
1. abre o `calendarUrl`, clica em **Criar história**;
2. envia o arquivo pelo `input[type=file]` (sem abrir diálogo nativo);
3. marca **Facebook** e **Instagram** como destino (se o compositor tiver esses toggles);
4. clica em **Publicar**;
5. **espera a confirmação de envio**; só então vai para o próximo.

Se um story der erro, ele **para a fila** e marca `status: "erro"` no `agenda.json`
— nada é repetido automaticamente. Corrija e rode de novo (os `publicado` são pulados).

## 6. Rodar sozinho todo dia

```bash
npm run daemon
```

Fica em execução e, no horário de `schedule.time`, publica os storys daquele dia.
Deixe a janela aberta (ou configure o **Agendador de Tarefas do Windows** para
rodar `npm run run` uma vez por dia).

---

## Ajustar quando a interface do Meta mudar

A UI do Meta muda com frequência e varia por idioma. Se o bot não achar um botão:

1. ponha `"debug": true` no `config.json` e rode de novo;
2. veja os prints em `./debug`;
3. ajuste os textos em `selectors.json` (`createStoryButton`, `publishButton`,
   `confirmationText`, etc.) para bater com o que aparece na sua conta.

## Arquivos

| arquivo | função |
|---|---|
| `publish-stories.js` | script principal (setup / plan / run / daemon) |
| `agenda.js` | planejador aleatório sem repetição |
| `config.json` | tudo que você configura |
| `selectors.json` | textos/seletores da interface do Meta |
| `agenda.json` | gerado pelo `plan`; guarda o status de cada story |
| `chrome-profile/` | sessão logada (não versionar, não compartilhar) |
