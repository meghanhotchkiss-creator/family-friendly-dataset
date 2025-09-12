import streamlit as st
import requests
import os

API_URL = os.getenv("API_URL", "http://localhost:8000/recommend")
API_KEY = os.getenv("FAMILY_API_KEY", "mysecretkey")

st.set_page_config(page_title="Family-Friendly Activities", layout="wide")
st.title("👨‍👩‍👧 Family-Friendly Activities Finder")

state = st.selectbox("Select a state", ["CA", "TX", "FL", "NY", "AZ", "OH", "GA", "IL"])
indoor = st.radio("Indoor or Outdoor?", ["Any", "indoor", "outdoor"], index=0)
limit = st.slider("Number of results", 1, 20, 5)

if st.button("Find Activities"):
    headers = {"X-API-Key": API_KEY}
    params = {"state": state, "limit": limit}
    if indoor != "Any":
        params["indoor"] = indoor
    try:
        r = requests.get(API_URL, headers=headers, params=params)
        results = r.json()

        if results:
            for r in results:
                st.subheader(r.get("name", "Unknown"))
                st.write(f"**Type:** {r.get('type', 'N/A')}")
                st.write(f"**State:** {r.get('state', 'N/A')}")
                st.write(f"**Indoor/Outdoor:** {r.get('indoor_or_outdoor', 'N/A')}")
                st.write("---")
        else:
            st.warning("No results found.")
    except Exception as e:
        st.error(f"Error fetching data: {e}")
