import React, { useState, useEffect } from "react";
import axios from "axios";

const API_URL = "https://family-api-xxxxxx.a.run.app";  // Replace with your deployed API
const API_KEY = "demo_pro_key";                         // Replace with your real key

export default function ScoutFoxWidget() {
  const [points, setPoints] = useState(0);
  const [activities, setActivities] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    axios.get(`${API_URL}/points/points_balance`, { headers: { "X-API-Key": API_KEY }})
      .then(res => setPoints(res.data.points));

    axios.get(`${API_URL}/points/leaderboard`, { headers: { "X-API-Key": API_KEY }})
      .then(res => setLeaderboard(res.data));

    axios.get(`${API_URL}/points/points_history`, { headers: { "X-API-Key": API_KEY }})
      .then(res => setHistory(res.data.history));
  }, []);

  const loadActivities = async () => {
    const res = await axios.get(`${API_URL}/recommend?state=CA&limit=5`, {
      headers: { "X-API-Key": API_KEY }
    });
    setActivities(res.data);
  };

  const bookActivity = async (id) => {
    const res = await axios.post(`${API_URL}/points/book_activity?activity_id=${id}`, {}, {
      headers: { "X-API-Key": API_KEY }
    });
    alert(`Booking created! You earned ${res.data.earned_points} points.`);
    setPoints(res.data.total_points);
    window.open(res.data.affiliate_link, "_blank");
  };

  const upgradeToPro = async () => {
    const res = await axios.post(`${API_URL}/payments/create-checkout-session`);
    window.location.href = res.data.checkout_url;
  };

  return (
    <div style={{ border: "2px solid #eee", padding: "20px", borderRadius: "12px", maxWidth: "700px", margin: "auto", background: "#fafafa" }}>
      <h2>🎯 ScoutFox Family Dashboard</h2>
      <p><strong>Your Points:</strong> {points}</p>

      <button onClick={loadActivities} style={{ margin: "10px", padding: "10px" }}>
        Find Activities
      </button>
      <ul>
        {activities.map((a, i) => (
          <li key={i}>
            {a.name} — {a.type || "activity"}
            <button onClick={() => bookActivity(a.id || i)} style={{ marginLeft: "10px" }}>
              Book Now
            </button>
          </li>
        ))}
      </ul>

      <button onClick={upgradeToPro} style={{ background: "gold", padding: "12px", borderRadius: "8px", border: "none", fontWeight: "bold", cursor: "pointer", marginTop: "20px" }}>
        ⭐ Upgrade to Pro
      </button>

      <h3 style={{ marginTop: "30px" }}>🏆 Leaderboard</h3>
      <ol>
        {leaderboard.map((e, i) => (
          <li key={i}>{e.badge} {e.user} — {e.points} pts ({e.tier})</li>
        ))}
      </ol>

      <h3>📜 Your Recent Activity</h3>
      <ul>
        {history.map((h, i) => (
          <li key={i}>
            {h.event === "affiliate_booking" 
              ? `Booked activity ${h.activity_id} +${h.points} pts`
              : `${h.event} ${h.points > 0 ? `+${h.points}` : h.points} pts`}
          </li>
        ))}
      </ul>
    </div>
  );
}
