import React, { useState, useEffect } from "react";
import axios from "axios";

const API_URL = "https://family-api-xxxxxx.a.run.app";  
const API_KEY = "demo_pro_key";                         

export default function LeaderboardWidget() {
  const [leaderboard, setLeaderboard] = useState([]);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    axios.get(`${API_URL}/points/leaderboard`, {
      headers: { "X-API-Key": API_KEY }
    }).then(res => setLeaderboard(res.data));

    axios.get(`${API_URL}/points/points_history`, {
      headers: { "X-API-Key": API_KEY }
    }).then(res => setHistory(res.data.history));
  }, []);

  return (
    <div>
      <h2>🏆 Family Leaderboard</h2>
      <ol>
        {leaderboard.map((e, i) => (
          <li key={i}>{e.badge} {e.user} — {e.points} pts ({e.tier})</li>
        ))}
      </ol>
      <h3>📜 Your Activity</h3>
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
