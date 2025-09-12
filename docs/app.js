document.getElementById('loadActivities').addEventListener('click', () => {
  const resultsDiv = document.getElementById('results');
  resultsDiv.innerHTML = '<p>Loading family activities...</p>';

  // Placeholder example - in future, replace with API call
  setTimeout(() => {
    resultsDiv.innerHTML = `
      <ul>
        <li>Visit your local library</li>
        <li>Explore the nearest state park</li>
        <li>Check out a family-friendly restaurant</li>
      </ul>
    `;
  }, 1000);
});
