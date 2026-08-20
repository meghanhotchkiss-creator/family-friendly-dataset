import datetime
import hashlib
import os
import threading

from fastapi import APIRouter, Depends, HTTPException

from auth_tiers import verify_tier, USER_TIERS
from seed_loader import history_by_user, points_by_user, user_display_names

router = APIRouter()

# NOTE: this state is process-local and lost on restart. It is not a durable
# ledger and will diverge across multiple workers. Persisting balances to the
# database is tracked separately; the rules below are written so that moving to
# a real store does not change the API surface.
_lock = threading.Lock()

# Seeded starting balances and history, so the dashboard has something to show
# on a fresh checkout. Loaded only alongside the seeded users themselves: with
# demo keys disabled these balances belong to nobody who can authenticate.
_SEEDED = os.getenv("ALLOW_DEMO_KEYS", "false").lower() == "true"

user_points = dict(points_by_user()) if _SEEDED else {}
user_history = {k: list(v) for k, v in history_by_user().items()} if _SEEDED else {}
last_checkin = {}

# api_key -> human-readable name. A display name is not a credential; the raw
# key must never leave the process (see public_user_id).
display_names = user_display_names() if _SEEDED else {}

# Points are defined here, on the server. The client names an event; it never
# supplies an amount.
EVENT_POINTS = {
    "daily_checkin": 10,
    "affiliate_booking": 20,
    "upgrade_pro": 50,
    "upgrade_business": 100,
}

# Only these events may be triggered by a caller. The upgrade events award
# large balances and must be granted by the billing flow after payment is
# confirmed, never self-reported: a free-tier caller could otherwise replay
# "upgrade_business" and mint points without limit.
CLIENT_REPORTABLE_EVENTS = {"daily_checkin"}


def public_user_id(api_key: str) -> str:
    """Return a stable, non-reversible identifier for public responses.

    The API key is the caller's credential. Returning it in a response body --
    as the leaderboard previously did -- hands every caller a working key for
    every other account, including higher tiers.
    """
    digest = hashlib.sha256(
        (os.getenv("PUBLIC_ID_SALT", "") + api_key).encode("utf-8")
    ).hexdigest()
    return "scout_" + digest[:12]


def _award(api_key: str, event: str, points: int, **extra):
    with _lock:
        user_points[api_key] = user_points.get(api_key, 0) + points
        entry = {"event": event, "points": points}
        entry.update(extra)
        user_history.setdefault(api_key, []).append(entry)
        return user_points[api_key]


@router.post("/earn_points")
def earn_points(event: str, api_key=Depends(verify_tier("free"))):
    if event not in EVENT_POINTS:
        raise HTTPException(status_code=400, detail="Unknown event")

    if event not in CLIENT_REPORTABLE_EVENTS:
        raise HTTPException(
            status_code=403,
            detail="This event cannot be self-reported",
        )

    points = EVENT_POINTS[event]
    today = datetime.date.today()

    with _lock:
        last = last_checkin.get(api_key)
        # One check-in per day. Without this, the endpoint can simply be
        # replayed for unlimited points.
        if last == today:
            raise HTTPException(status_code=409, detail="Already checked in today")
        if last == today - datetime.timedelta(days=1):
            points *= 2
        last_checkin[api_key] = today

    total = _award(api_key, event, points)
    return {"event": event, "earned": points, "total_points": total}


@router.post("/book_activity")
def book_activity(activity_id: str, api_key=Depends(verify_tier("free"))):
    affiliate_base = os.getenv("AFFILIATE_BASE_URL", "https://partner.scoutfoxtravel.com/book")
    affiliate_ref = os.getenv("AFFILIATE_REF", "")
    affiliate_link = f"{affiliate_base}/{activity_id}"
    if affiliate_ref:
        affiliate_link += f"?ref={affiliate_ref}"

    points = EVENT_POINTS["affiliate_booking"]
    total = _award(api_key, "affiliate_booking", points, activity_id=activity_id)
    return {
        "message": "Booking created",
        "affiliate_link": affiliate_link,
        "earned_points": points,
        "total_points": total,
    }


@router.get("/points_balance")
def points_balance(api_key=Depends(verify_tier("free"))):
    return {"points": user_points.get(api_key, 0)}


@router.get("/points_history")
def points_history(api_key=Depends(verify_tier("free"))):
    return {"history": user_history.get(api_key, [])}


@router.post("/redeem_points")
def redeem_points(cost: int, api_key=Depends(verify_tier("free"))):
    # A negative cost would add points rather than spend them.
    if cost <= 0:
        raise HTTPException(status_code=400, detail="Cost must be positive")

    with _lock:
        balance = user_points.get(api_key, 0)
        if balance < cost:
            raise HTTPException(status_code=400, detail="Not enough points")
        user_points[api_key] = balance - cost
        user_history.setdefault(api_key, []).append({"event": "redeem", "points": -cost})
        remaining = user_points[api_key]

    return {"points": remaining, "message": "Redeemed successfully"}


@router.get("/leaderboard")
def leaderboard(api_key=Depends(verify_tier("free"))):
    entries = []
    for key, pts in user_points.items():
        tier = USER_TIERS.get(key, "free")
        badge = "⭐" if tier == "pro" else "👑" if tier == "business" else ""
        entries.append(
            {
                # Never the raw key. A seeded display name is shown when
                # one exists; otherwise a salted, non-reversible id.
                "user": display_names.get(key) or public_user_id(key),
                "points": pts,
                "tier": tier,
                "badge": badge,
            }
        )
    tier_order = {"business": 2, "pro": 1, "free": 0}
    entries.sort(key=lambda x: (x["points"], tier_order[x["tier"]]), reverse=True)
    return entries
