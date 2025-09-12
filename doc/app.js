async function loadActivities() {
  const res = await fetch("https://family-api-xxxxxx.a.run.app/recommend?state=CA&limit=5", {
    headers: { "X-API-Key": "demo_pro_key" }
  });
  const data = await res.json();
  const list = document.getElementById("results");
  list.innerHTML = "";
  data.forEach(a => {
    const li = document.createElement("li");
    li.textContent = `${a.name} (${a.type || "activity"})`;
    list.appendChild(li);
  });
}
