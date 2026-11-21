# agy-pi

`agy-pi` é uma CLI leve e eficiente construída sobre o SDK `@earendil-works/pi-coding-agent`, integrando agentes e modelos externos do Pi (`~/.pi/agent`) diretamente ao ecossistema Antigravity com **zero overhead de tokens MCP fixos** (utilizando progressive disclosure via Antigravity Skill).

---

## Requisitos

- **Node.js**: `>= 22.19.0`
- **Autenticação Pi**: Autenticado via `pi` (`/login` ou configuração em `~/.pi/agent/models.json`).

---

## Instalação

Escolha uma das três formas limpas de instalação:

### a) Instalação rápida via cURL (Recomendado para qualquer máquina):
```bash
curl -fsSL https://raw.githubusercontent.com/mjabbur/antigravity-pi/main/scripts/install.sh | bash
```

### b) A partir de um clone local:
```bash
git clone https://github.com/mjabbur/antigravity-pi.git && cd antigravity-pi && ./scripts/install.sh
```

### c) CLI apenas via npm + Plugin Antigravity:
```bash
npm install -g github:mjabbur/antigravity-pi
agy plugin install https://github.com/mjabbur/antigravity-pi
```

---

## Desinstalação

Se instalou via script (`install.sh`), você pode desinstalar facilmente sem perder suas sessões do Pi ou arquivos de configuração:
```bash
./scripts/install.sh --uninstall
```

---

## Exemplos Práticos de Uso

### Listar Modelos Disponíveis
```bash
agy-pi models
agy-pi models openai
```

### Consulta Rápida (`ask`)
Ideal para code review, opiniões e análise de arquivos específicos:
```bash
agy-pi ask --model anthropic/claude-3-5-sonnet --file src/index.ts "Analise este código e aponte possíveis gargalos."
```

### Execução de Agente (`run`)
Para exploração de código ou refatoração (modo `readonly` por padrão, ou `coder` para edições):
```bash
agy-pi run --mode readonly --cwd . "Verifique a cobertura de testes e a estrutura do projeto."
```

### Saída em JSON (`--json`)
Útil para automações e scripts:
```bash
agy-pi models --json
```
