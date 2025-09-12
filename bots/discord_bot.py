import os, requests, discord
from discord.ext import commands
from nlu_parser import parse_query

DISCORD_TOKEN = os.getenv("DISCORD_BOT_TOKEN")
API_URL = "http://localhost:8000/recommend"
API_KEY = os.getenv("FAMILY_API_KEY", "mysecretkey")

intents = discord.Intents.default()
bot = commands.Bot(command_prefix="!", intents=intents)

def get_recommendations(filters):
    headers = {"X-API-Key": API_KEY}
    params = {"state": filters["state"], "indoor": filters["indoor"], "limit": 5}
    r = requests.get(API_URL, headers=headers, params=params)
    return r.json()

@bot.command(name="family")
async def family(ctx, *, query: str):
    filters = parse_query(query)
    results = get_recommendations(filters)
    reply = "\n".join([f"• {r['name']} ({r.get('type','')})" for r in results]) if results else "Sorry, I couldn’t find anything."
    await ctx.send(f"Here are family-friendly activities:\n{reply}")

if __name__ == "__main__":
    bot.run(DISCORD_TOKEN)
