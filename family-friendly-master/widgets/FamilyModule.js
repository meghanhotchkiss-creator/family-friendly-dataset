import React, { useState, useEffect } from "react";
import axios from "axios";

const API_URL = "https://family-api-xxxxxx.a.run.app";  
const API_KEY = "demo_pro_key";                         

export default function FamilyModule() {
  const [points, setPoints] = useState(0);
  const [activities, setActivities] = useState([]);

  useEffect(() => {
    axios.get(`${API_URL}/points/points_balance`, {
      headers: { "X-API-Key": API_KEY }
    }).then(res => setPoints(res.data.points));
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
    <div>
      <h2>🎯 ScoutFox Family Dashboard</h2>
      <p>Points: {points}</p>
      <button onClick={loadActivities}>Find Activities</button>
      <ul>
        {activities.map((a, i) => (
          <li key={i}>
            {a.name} — {a.type}
            <button onClick={() => bookActivity(a.id || i)}>Book Now</button>
          </li>
        ))}
      </ul>
      <button onClick={upgradeToPro}>⭐ Upgrade to Pro</button>
    </div>
  );
}
