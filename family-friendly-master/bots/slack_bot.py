import os, requests
from slack_bolt import App
from slack_bolt.adapter.socket_mode import SocketModeHandler
from nlu_parser import parse_query

SLACK_BOT_TOKEN = os.getenv("SLACK_BOT_TOKEN")
SLACK_APP_TOKEN = os.getenv("SLACK_APP_TOKEN")
API_URL = "http://localhost:8000/recommend"
API_KEY = os.getenv("FAMILY_API_KEY", "mysecretkey")

app = App(token=SLACK_BOT_TOKEN)

def get_recommendations(filters):
    headers = {"X-API-Key": API_KEY}
    params = {"state": filters["state"], "indoor": filters["indoor"], "limit": 5}
    r = requests.get(API_URL, headers=headers, params=params)
    return r.json()

@app.message("family")
def handle_message(message, say):
    query = message["text"]
    filters = parse_query(query)
    results = get_recommendations(filters)
    reply = "\n".join([f"• {r['name']} ({r.get('type','')})" for r in results]) if results else "Sorry, I couldn’t find anything."
    say(f"Here are family-friendly activities:\n{reply}")

if __name__ == "__main__":
    handler = SocketModeHandler(app, SLACK_APP_TOKEN)
    handler.start()
