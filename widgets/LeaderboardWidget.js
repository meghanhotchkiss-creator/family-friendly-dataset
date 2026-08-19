import React, { useState, useEffect } from "react";
import axios from "axios";
import { API_URL, authHeaders } from "./config";


export default function LeaderboardWidget() {
  const [leaderboard, setLeaderboard] = useState([]);
  const [history, setHistory] = useState([]);

  useEffect(() => {
    axios.get(`${API_URL}/points/leaderboard`, { headers: authHeaders() }).then(res => setLeaderboard(res.data));

    axios.get(`${API_URL}/points/points_history`, { headers: authHeaders() }).then(res => setHistory(res.data.history));
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
