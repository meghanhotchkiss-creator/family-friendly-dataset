# Family Friendly Master Bundle

This master bundle includes:
- API (FastAPI + Docker + BigQuery + Firebase/Auth)
- Slack Bot (with NLU)
- Discord Bot (with NLU)

## 🚀 Quick Start

### API
```bash
cd api
pip install -r requirements.txt
export FAMILY_API_KEY="mysecretkey"
uvicorn server:app --host 0.0.0.0 --port 8000
```

### Slack Bot
```bash
cd bots
pip install spacy slack_bolt requests
python -m spacy download en_core_web_sm
export SLACK_BOT_TOKEN="xoxb-your-slack-token"
export SLACK_APP_TOKEN="xapp-your-slack-app-token"
export FAMILY_API_KEY="mysecretkey"
python slack_bot.py
```

### Discord Bot
```bash
cd bots
pip install spacy discord.py requests
python -m spacy download en_core_web_sm
export DISCORD_BOT_TOKEN="your-discord-token"
export FAMILY_API_KEY="mysecretkey"
python discord_bot.py
```
