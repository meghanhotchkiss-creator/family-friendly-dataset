# Seed data pipeline. Everything here runs on a bare checkout with no
# third-party packages installed -- the seed tooling is standard library only.

PYTHON ?= python3

.PHONY: help seed validate dataset db sql test api dashboard clean

help:
	@echo "make seed      - validate seeds, build the dataset and the databases"
	@echo "make validate  - check data/seeds/*.json for consistency"
	@echo "make dataset   - build data/processed/family_friendly_dataset.{csv,json}"
	@echo "make db        - build the SQLite database at data/processed/scoutfox.db"
	@echo "make sql       - write db/seed.sql for PostgreSQL"
	@echo "make test      - run the seed data test suite"
	@echo "make api       - run the API on :8000 (needs api/requirements.txt)"
	@echo "make dashboard - run the Streamlit dashboard (needs dashboard/requirements.txt)"
	@echo "make clean     - remove generated files in data/processed and db/seed.sql"

seed: validate dataset db sql

validate:
	$(PYTHON) scripts/validate_seeds.py

dataset:
	$(PYTHON) scripts/build_dataset.py

db:
	$(PYTHON) scripts/seed_db.py --sqlite

sql:
	$(PYTHON) scripts/seed_db.py --sql

test:
	$(PYTHON) -m unittest discover -s tests -v

api: dataset
	cd api && uvicorn server:app --host 0.0.0.0 --port 8000 --reload

dashboard:
	cd dashboard && streamlit run app.py

clean:
	rm -f data/processed/family_friendly_dataset.csv \
	      data/processed/family_friendly_dataset.json \
	      data/processed/scoutfox.db \
	      db/seed.sql
