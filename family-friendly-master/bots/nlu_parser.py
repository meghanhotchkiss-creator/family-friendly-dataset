import spacy

nlp = spacy.load("en_core_web_sm")

STATES = {
    "california": "CA", "texas": "TX", "florida": "FL", "new york": "NY",
    "arizona": "AZ", "ohio": "OH", "georgia": "GA", "illinois": "IL",
}

def parse_query(text: str):
    doc = nlp(text.lower())
    state, indoor, price, category = None, None, None, None

    if "indoor" in text:
        indoor = "indoor"
    elif "outdoor" in text:
        indoor = "outdoor"

    if "free" in text:
        price = "free"
    elif "cheap" in text or "low cost" in text:
        price = "$"
    elif "expensive" in text or "fancy" in text:
        price = "$$$"

    for token in doc:
        if token.lemma_ in ["park", "museum", "library", "zoo", "restaurant", "aquarium"]:
            category = token.lemma_

    for phrase, abbr in STATES.items():
        if phrase in text:
            state = abbr
            break

    return {"state": state or "CA", "indoor": indoor, "price": price, "category": category}
