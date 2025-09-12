#!/usr/bin/env python3
"""
Family-Friendly Dataset Collection Script

This script collects data from various family-friendly sources and
saves it to the raw data directory for further processing.
"""

import os
import sys
import json
import requests
import pandas as pd
from datetime import datetime
from pathlib import Path
import logging
from typing import Dict, List, Any

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class DataCollector:
    """Collects family-friendly content from various sources."""
    
    def __init__(self, output_dir: str = "data/raw"):
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
    def collect_sample_data(self) -> Dict[str, Any]:
        """
        Collect sample family-friendly content.
        In a real implementation, this would connect to APIs or scrape websites.
        """
        logger.info("Collecting sample family-friendly data...")
        
        # Sample family-friendly content
        sample_data = {
            "books": [
                {
                    "title": "Charlotte's Web",
                    "author": "E.B. White",
                    "age_range": "8-12",
                    "genre": "Children's Fiction",
                    "rating": 4.8,
                    "family_friendly": True,
                    "content_warnings": []
                },
                {
                    "title": "Harry Potter and the Sorcerer's Stone",
                    "author": "J.K. Rowling", 
                    "age_range": "10-14",
                    "genre": "Fantasy",
                    "rating": 4.7,
                    "family_friendly": True,
                    "content_warnings": ["mild fantasy violence"]
                },
                {
                    "title": "The Cat in the Hat",
                    "author": "Dr. Seuss",
                    "age_range": "3-8",
                    "genre": "Picture Book",
                    "rating": 4.9,
                    "family_friendly": True,
                    "content_warnings": []
                }
            ],
            "movies": [
                {
                    "title": "Toy Story",
                    "director": "John Lasseter",
                    "year": 1995,
                    "rating": "G",
                    "genre": "Animation",
                    "family_friendly": True,
                    "content_warnings": []
                },
                {
                    "title": "Finding Nemo",
                    "director": "Andrew Stanton",
                    "year": 2003,
                    "rating": "G", 
                    "genre": "Animation",
                    "family_friendly": True,
                    "content_warnings": ["mild peril"]
                }
            ],
            "games": [
                {
                    "title": "Minecraft",
                    "platform": "Multi-platform",
                    "age_rating": "E10+",
                    "genre": "Sandbox",
                    "family_friendly": True,
                    "content_warnings": ["fantasy violence"]
                },
                {
                    "title": "Animal Crossing",
                    "platform": "Nintendo",
                    "age_rating": "E",
                    "genre": "Life Simulation",
                    "family_friendly": True,
                    "content_warnings": []
                }
            ]
        }
        
        return sample_data
    
    def save_data(self, data: Dict[str, Any], filename: str = None) -> str:
        """Save collected data to JSON file."""
        if filename is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"family_friendly_data_{timestamp}.json"
            
        filepath = self.output_dir / filename
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            
        logger.info(f"Data saved to {filepath}")
        return str(filepath)
    
    def create_metadata(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Create metadata about the collected dataset."""
        metadata = {
            "collection_date": datetime.now().isoformat(),
            "total_items": sum(len(category) for category in data.values()),
            "categories": list(data.keys()),
            "category_counts": {k: len(v) for k, v in data.items()},
            "family_friendly_percentage": self._calculate_family_friendly_percentage(data)
        }
        return metadata
    
    def _calculate_family_friendly_percentage(self, data: Dict[str, Any]) -> float:
        """Calculate the percentage of family-friendly content."""
        total_items = 0
        family_friendly_items = 0
        
        for category in data.values():
            for item in category:
                total_items += 1
                if item.get('family_friendly', False):
                    family_friendly_items += 1
                    
        return (family_friendly_items / total_items * 100) if total_items > 0 else 0

def main():
    """Main function to run data collection."""
    try:
        logger.info("Starting family-friendly data collection...")
        
        collector = DataCollector()
        
        # Collect data
        data = collector.collect_sample_data()
        
        # Save main dataset
        data_filepath = collector.save_data(data)
        
        # Create and save metadata
        metadata = collector.create_metadata(data)
        metadata_filepath = collector.save_data(metadata, "collection_metadata.json")
        
        logger.info(f"Collection complete!")
        logger.info(f"- Data file: {data_filepath}")
        logger.info(f"- Metadata file: {metadata_filepath}")
        logger.info(f"- Total items collected: {metadata['total_items']}")
        logger.info(f"- Family-friendly percentage: {metadata['family_friendly_percentage']:.1f}%")
        
        return 0
        
    except Exception as e:
        logger.error(f"Error during data collection: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())