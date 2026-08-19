from fastapi import APIRouter, Depends
from auth_tiers import verify_tier, USER_TIERS
from seed_loader import history_by_user, points_by_user, user_display_names
import datetime

router = APIRouter()

# Balances and history start from data/seeds/. Every seeded balance equals the
# sum of that user's ledger entries (enforced by scripts/validate_seeds.py), so
# /points_balance and /points_history agree on the first request.
FALLBACK_POINTS = {"demo_free_key": 50, "demo_pro_key": 120, "demo_business_key": 500}

user_points = {**FALLBACK_POINTS, **points_by_user()}
user_history = {key: [] for key in user_points}
user_history.update(history_by_user())
display_names = user_display_names()
last_checkin = {}

@router.post("/earn_points")
def earn_points(event: str, api_key=Depends(verify_tier("free"))):
    event_points = {"daily_checkin": 10, "affiliate_booking": 20, "upgrade_pro": 50, "upgrade_business": 100}
    points = event_points.get(event, 0)
    if event == "daily_checkin":
        today = datetime.date.today()
        last = last_checkin.get(api_key)
        if last == today - datetime.timedelta(days=1):
            points *= 2
        last_checkin[api_key] = today
    user_points[api_key] = user_points.get(api_key, 0) + points
    user_history.setdefault(api_key, []).append(
        {"event": event, "points": points, "date": datetime.date.today().isoformat()}
    )
    return {"event": event, "earned": points, "total_points": user_points[api_key]}

@router.post("/book_activity")
def book_activity(activity_id: str, api_key=Depends(verify_tier("free"))):
    affiliate_link = f"https://partner.scoutfoxtravel.com/book/{activity_id}?ref=your_affiliate_id"
    user_points[api_key] = user_points.get(api_key, 0) + 20
    user_history.setdefault(api_key, []).append(
        {"event": "affiliate_booking", "points": 20, "activity_id": activity_id,
         "date": datetime.date.today().isoformat()}
    )
    return {"message": "Booking created", "affiliate_link": affiliate_link, "earned_points": 20, "total_points": user_points[api_key]}

@router.get("/points_balance")
def points_balance(api_key=Depends(verify_tier("free"))):
    return {"points": user_points.get(api_key, 0)}

@router.get("/points_history")
def points_history(api_key=Depends(verify_tier("free"))):
    return {"history": user_history.get(api_key, [])}

@router.post("/redeem_points")
def redeem_points(cost: int, api_key=Depends(verify_tier("free"))):
    if user_points.get(api_key, 0) < cost:
        return {"error": "Not enough points"}
    user_points[api_key] -= cost
    user_history.setdefault(api_key, []).append(
        {"event": "redeem", "points": -cost, "date": datetime.date.today().isoformat()}
    )
    return {"points": user_points[api_key], "message": "Redeemed successfully"}

@router.get("/leaderboard")
def leaderboard(api_key=Depends(verify_tier("free"))):
    entries = []
    for key, pts in user_points.items():
        tier = USER_TIERS.get(key, "free")
        badge = "⭐" if tier == "pro" else "👑" if tier == "business" else ""
        entries.append({"user": display_names.get(key, key), "api_key": key,
                        "points": pts, "tier": tier, "badge": badge})
    tier_order = {"business": 2, "pro": 1, "free": 0}
    entries.sort(key=lambda x: (x["points"], tier_order.get(x["tier"], 0)), reverse=True)
    return entries
