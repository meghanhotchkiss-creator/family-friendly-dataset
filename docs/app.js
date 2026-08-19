/*
 * Scout Fox Family Explorer.
 *
 * This file previously rendered three hardcoded suggestions behind a
 * setTimeout, with the comment "in future, replace with API call". It now
 * calls the real API.
 *
 * Configuration: set window.SCOUTFOX_CONFIG before this script loads (see
 * index.html). The API key here reaches the browser and is therefore public --
 * it must be a free-tier, rate-limited key.
 */
(function () {
  "use strict";

  var CONFIG = window.SCOUTFOX_CONFIG || {};
  var API_URL = (CONFIG.apiUrl || "http://localhost:8000").replace(/\/$/, "");
  var API_KEY = CONFIG.apiKey || "";

  var els = {
    state: document.getElementById("state"),
    indoor: document.getElementById("indoor"),
    query: document.getElementById("query"),
    limit: document.getElementById("limit"),
    form: document.getElementById("finder"),
    results: document.getElementById("results"),
    status: document.getElementById("status"),
    count: document.getElementById("count")
  };

  function setStatus(kind, message) {
    els.status.className = "status show " + kind;
    els.status.textContent = message;
  }

  function clearStatus() {
    els.status.className = "status";
    els.status.textContent = "";
  }

  function request(path) {
    return fetch(API_URL + path, { headers: { "X-API-Key": API_KEY } }).then(function (response) {
      if (response.status === 401) {
        throw new Error("The API rejected our key. Check the key configured for this page.");
      }
      if (!response.ok) {
        throw new Error("The API returned " + response.status + ".");
      }
      return response.json();
    });
  }

  /* Populate the filters from the data rather than hardcoding a state list.
     The old dashboard shipped eight states; the dataset now covers far more,
     and a hardcoded list silently hides the rest. */
  function loadFilters() {
    return request("/meta").then(function (meta) {
      els.state.innerHTML = "";
      meta.states.forEach(function (code) {
        var option = document.createElement("option");
        option.value = code;
        option.textContent = code;
        els.state.appendChild(option);
      });
      if (meta.states.indexOf("CA") !== -1) {
        els.state.value = "CA";
      }
      els.count.textContent =
        meta.rows + " activities across " + meta.states.length + " states";
    });
  }

  function priceLabel(band) {
    if (!band) return "";
    return band === "free" ? "Free" : band;
  }

  function ageLabel(row) {
    var min = Number(row.min_age);
    var max = Number(row.max_age);
    if (!isFinite(min) && !isFinite(max)) return "";
    if (min <= 0 && max >= 99) return "All ages";
    if (max >= 99) return min + "+";
    return "Ages " + min + "–" + max;
  }

  function card(row) {
    var article = document.createElement("article");
    article.className = "card";

    var heading = document.createElement("h3");
    if (row.url) {
      var link = document.createElement("a");
      link.href = row.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = row.name;
      heading.appendChild(link);
    } else {
      heading.textContent = row.name;
    }
    article.appendChild(heading);

    var where = document.createElement("p");
    where.className = "where";
    where.textContent = [row.city, row.state].filter(Boolean).join(", ");
    article.appendChild(where);

    var tags = document.createElement("ul");
    tags.className = "tags";
    [
      row.type ? row.type.replace(/_/g, " ") : "",
      row.indoor_or_outdoor,
      priceLabel(row.price_band),
      ageLabel(row)
    ]
      .filter(Boolean)
      .forEach(function (text) {
        var li = document.createElement("li");
        li.textContent = text;
        tags.appendChild(li);
      });
    article.appendChild(tags);

    /* Seed rows have not been checked by a human. Saying so is better than
       letting a family discover it at the gate. */
    if (String(row.verified) !== "true") {
      var note = document.createElement("p");
      note.className = "unverified";
      note.textContent = "Details not yet verified — check the official site before you go.";
      article.appendChild(note);
    }

    return article;
  }

  function render(rows) {
    els.results.innerHTML = "";

    if (!rows.length) {
      setStatus("warn", "Nothing matched those filters. Try a different state, or clear the search box.");
      return;
    }

    clearStatus();
    rows.forEach(function (row) {
      els.results.appendChild(card(row));
    });
  }

  function search(event) {
    if (event) event.preventDefault();

    var query = els.query.value.trim();
    var limit = els.limit.value;
    var path;

    if (query) {
      // Free-text search is state-independent; the API ranks by name.
      path = "/search?q=" + encodeURIComponent(query) + "&limit=" + encodeURIComponent(limit);
    } else {
      path = "/recommend?state=" + encodeURIComponent(els.state.value) + "&limit=" + encodeURIComponent(limit);
      if (els.indoor.value !== "any") {
        path += "&indoor=" + encodeURIComponent(els.indoor.value);
      }
    }

    setStatus("info", "Searching…");

    request(path)
      .then(function (payload) {
        // /recommend returns an array, /search returns {results: [...]}.
        render(Array.isArray(payload) ? payload : payload.results || []);
      })
      .catch(function (error) {
        // Never render an empty list as if it were a real "no results".
        setStatus("error", error.message + " Nothing was searched.");
        els.results.innerHTML = "";
      });
  }

  els.form.addEventListener("submit", search);

  loadFilters()
    .then(search)
    .catch(function (error) {
      setStatus(
        "error",
        "Could not reach the activities API. " +
          error.message +
          " If you are running locally, start it with: uvicorn server:app --port 8000"
      );
    });
})();
