import os
import stripe
from fastapi import APIRouter, HTTPException

router = APIRouter()

stripe.api_key = os.getenv("STRIPE_SECRET_KEY")
PRICE_ID = os.getenv("STRIPE_PRICE_ID")  # Pre-configured Stripe Price ID

@router.post("/create-checkout-session")
def create_checkout_session():
    try:
        session = stripe.checkout.Session.create(
            payment_method_types=["card"],
            line_items=[{"price": PRICE_ID, "quantity": 1}],
            mode="subscription",
            success_url=os.getenv("SUCCESS_URL", "https://yourapp.com/success?session_id={CHECKOUT_SESSION_ID}"),
            cancel_url=os.getenv("CANCEL_URL", "https://yourapp.com/cancel"),
        )
        return {"checkout_url": session.url}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
