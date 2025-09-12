# Family-Friendly Dataset

A curated collection of family-friendly books, movies, and games with automated quality assurance and content filtering.

## 🎯 Overview

This repository contains a comprehensive pipeline for collecting, processing, and validating family-friendly content across multiple categories. The dataset is designed to help families discover appropriate entertainment options for children and young adults.

## 📊 Dataset Categories

- **📚 Books**: Children's literature, young adult novels, educational content
- **🎬 Movies**: Family-friendly films with appropriate ratings
- **🎮 Games**: Video games suitable for children and families

## 🚀 Quick Start

### Prerequisites

- Python 3.8 or higher
- pip package manager

### Installation

1. Clone the repository:
```bash
git clone https://github.com/yourusername/family-friendly-dataset.git
cd family-friendly-dataset
```

2. Install dependencies:
```bash
pip install -r requirements.txt
```

3. Run the complete pipeline:
```bash
python scripts/run_pipeline.py
```

## 📁 Project Structure

```
family-friendly-dataset/
├── scripts/                    # Data pipeline scripts
│   ├── collect_data.py        # Data collection
│   ├── process_data.py        # Data processing & filtering
│   ├── validate_dataset.py    # Quality validation
│   └── run_pipeline.py        # Complete pipeline
├── data/                      # Data directories
│   ├── raw/                   # Raw collected data
│   ├── processed/             # Filtered & cleaned data
│   └── final/                 # Final validated dataset
├── config/                    # Configuration files
│   └── dataset_config.yaml    # Dataset configuration
├── .github/workflows/         # CI/CD workflows
│   ├── ci.yml                # Continuous integration
│   └── release.yml           # Release automation
├── requirements.txt           # Python dependencies
└── README.md                 # This file
```

## 🔧 Pipeline Components

### 1. Data Collection (`collect_data.py`)
- Collects family-friendly content from various sources
- Creates sample dataset with books, movies, and games
- Generates collection metadata

### 2. Data Processing (`process_data.py`)
- Filters content based on family-friendly criteria
- Removes inappropriate content warnings
- Standardizes data formats
- Generates processing reports

### 3. Dataset Validation (`validate_dataset.py`)
- Validates data quality and completeness
- Ensures family-friendly standards are met
- Creates final validated dataset
- Generates validation reports

### 4. Pipeline Orchestration (`run_pipeline.py`)
- Runs all pipeline steps in sequence
- Provides comprehensive logging
- Reports success/failure status

## 📋 Content Filtering Criteria

### Family-Friendly Standards
- ✅ Appropriate age ratings (G, PG, E, E10+, etc.)
- ✅ No explicit or graphic content
- ✅ Educational or entertainment value
- ✅ Positive role models and messages

### Content Warnings
- ❌ Explicit violence or graphic content
- ❌ Adult themes or mature content
- ❌ Inappropriate language
- ✅ Mild fantasy violence (allowed)
- ✅ Brief mild language (allowed)

## 🔄 Automated Workflows

### Continuous Integration
- Runs on every push and pull request
- Tests all pipeline scripts
- Validates dataset quality
- Generates dataset reports

### Release Generation
- Creates tagged releases with dataset packages
- Includes validation reports and documentation
- Provides downloadable dataset archives

## 📊 Dataset Usage

### Loading the Dataset

```python
import json

# Load the complete dataset
with open('data/final/family_friendly_dataset.json', 'r') as f:
    dataset = json.load(f)

# Access different categories
books = dataset['books']
movies = dataset['movies'] 
games = dataset['games']

# View metadata
metadata = dataset['metadata']
print(f"Total items: {metadata['total_items']}")
print(f"Validity rate: {metadata['validity_rate']}%")
```

### Example Data Structure

```json
{
  "metadata": {
    "creation_date": "2024-01-01T12:00:00",
    "dataset_name": "Family-Friendly Content Dataset",
    "version": "1.0.0",
    "total_items": 10,
    "validity_rate": 100.0
  },
  "books": [
    {
      "title": "Charlotte's Web",
      "author": "E.B. White",
      "age_range": "8-12",
      "genre": "Children's Fiction",
      "rating": 4.8,
      "family_friendly": true,
      "content_warnings": []
    }
  ],
  "movies": [...],
  "games": [...]
}
```

## 🧪 Testing

Run individual pipeline components:

```bash
# Test data collection
python scripts/collect_data.py

# Test data processing
python scripts/process_data.py

# Test validation
python scripts/validate_dataset.py

# Run complete pipeline
python scripts/run_pipeline.py
```

## 📈 Quality Metrics

The dataset maintains high quality standards:
- **Minimum 90% validity rate** for all content
- **Complete required fields** for all items
- **Family-friendly verification** for all content
- **Automated quality checks** in CI/CD pipeline

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the MIT License - see the LICENSE file for details.

## 🙏 Acknowledgments

- Thanks to all contributors who help maintain family-friendly content standards
- Special recognition to content creators who prioritize family-appropriate material
- Appreciation for the open-source community supporting educational datasets