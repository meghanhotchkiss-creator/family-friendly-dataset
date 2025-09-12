#!/usr/bin/env python3
"""
Family-Friendly Dataset Processing Script

This script processes raw data to filter and clean family-friendly content,
ensuring all content meets appropriate standards for families.
"""

import os
import sys
import json
import pandas as pd
from datetime import datetime
from pathlib import Path
import logging
from typing import Dict, List, Any, Optional
import re

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class FamilyFriendlyProcessor:
    """Processes and filters content for family-friendly criteria."""
    
    # Content filtering rules
    INAPPROPRIATE_KEYWORDS = [
        'violence', 'explicit', 'mature', 'adult', 'inappropriate',
        'graphic', 'disturbing', 'scary', 'frightening'
    ]
    
    FAMILY_RATINGS = ['G', 'PG', 'E', 'E10+', 'TV-Y', 'TV-G', 'TV-PG']
    
    def __init__(self, input_dir: str = "data/raw", output_dir: str = "data/processed"):
        self.input_dir = Path(input_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        
    def load_raw_data(self, filename: str = None) -> Dict[str, Any]:
        """Load raw data from JSON file."""
        if filename is None:
            # Find the most recent data file
            json_files = list(self.input_dir.glob("family_friendly_data_*.json"))
            if not json_files:
                raise FileNotFoundError("No data files found in raw directory")
            filename = max(json_files, key=lambda x: x.stat().st_mtime).name
            
        filepath = self.input_dir / filename
        logger.info(f"Loading data from {filepath}")
        
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def is_family_friendly(self, item: Dict[str, Any]) -> bool:
        """
        Determine if an item is family-friendly based on various criteria.
        """
        # Check explicit family_friendly flag
        if not item.get('family_friendly', True):
            return False
            
        # Check rating if available
        rating = item.get('rating', '')
        age_rating = item.get('age_rating', '')
        
        # Convert rating to string and handle numerical ratings
        if rating is not None:
            if isinstance(rating, (int, float)):
                # Numerical rating (0-5 scale), allow all as they're generally safe
                if not (0 <= rating <= 5):
                    return False
            else:
                rating_str = str(rating).upper()
                if rating_str and rating_str not in self.FAMILY_RATINGS:
                    # Allow some flexibility for ratings like PG-13
                    if rating_str not in ['PG-13']:
                        return False
        
        if age_rating is not None:
            age_rating_str = str(age_rating).upper()
            if age_rating_str and age_rating_str not in self.FAMILY_RATINGS:
                return False
                
        if age_rating and age_rating not in self.FAMILY_RATINGS:
            return False
        
        # Check content warnings
        content_warnings = item.get('content_warnings', [])
        if content_warnings:
            for warning in content_warnings:
                warning_lower = warning.lower()
                if any(keyword in warning_lower for keyword in self.INAPPROPRIATE_KEYWORDS):
                    return False
        
        # Check age range
        age_range = item.get('age_range', '')
        if age_range:
            # Extract minimum age
            min_age = self._extract_min_age(age_range)
            if min_age is not None and min_age > 16:
                return False
        
        return True
    
    def _extract_min_age(self, age_range: str) -> Optional[int]:
        """Extract minimum age from age range string."""
        if not age_range:
            return None
            
        # Look for patterns like "8-12", "10+", "3-8"
        numbers = re.findall(r'\d+', age_range)
        if numbers:
            return int(numbers[0])
        return None
    
    def clean_content_warnings(self, warnings: List[str]) -> List[str]:
        """Clean and standardize content warnings."""
        cleaned_warnings = []
        for warning in warnings:
            warning = warning.strip().lower()
            # Keep only mild warnings
            if any(mild_term in warning for mild_term in ['mild', 'brief', 'minimal']):
                cleaned_warnings.append(warning)
            elif not any(inappropriate in warning for inappropriate in self.INAPPROPRIATE_KEYWORDS):
                cleaned_warnings.append(warning)
        return cleaned_warnings
    
    def process_category(self, items: List[Dict[str, Any]], category_name: str) -> List[Dict[str, Any]]:
        """Process items in a specific category."""
        logger.info(f"Processing {len(items)} items in category: {category_name}")
        
        processed_items = []
        filtered_count = 0
        
        for item in items:
            if self.is_family_friendly(item):
                # Clean the item
                processed_item = item.copy()
                
                # Clean content warnings
                if 'content_warnings' in processed_item:
                    processed_item['content_warnings'] = self.clean_content_warnings(
                        processed_item['content_warnings']
                    )
                
                # Add processing metadata
                processed_item['processed_date'] = datetime.now().isoformat()
                processed_item['family_friendly_verified'] = True
                
                processed_items.append(processed_item)
            else:
                filtered_count += 1
                logger.debug(f"Filtered out item: {item.get('title', 'Unknown')}")
        
        logger.info(f"Kept {len(processed_items)} items, filtered {filtered_count} items")
        return processed_items
    
    def process_data(self, raw_data: Dict[str, Any]) -> Dict[str, Any]:
        """Process all categories of data."""
        logger.info("Starting data processing...")
        
        processed_data = {}
        
        for category, items in raw_data.items():
            if isinstance(items, list):
                processed_data[category] = self.process_category(items, category)
            else:
                # Keep non-list data as-is (like metadata)
                processed_data[category] = items
        
        return processed_data
    
    def create_processing_report(self, raw_data: Dict[str, Any], processed_data: Dict[str, Any]) -> Dict[str, Any]:
        """Create a report about the processing results."""
        report = {
            "processing_date": datetime.now().isoformat(),
            "categories_processed": {},
            "overall_stats": {}
        }
        
        total_raw = 0
        total_processed = 0
        
        for category in raw_data:
            if isinstance(raw_data[category], list):
                raw_count = len(raw_data[category])
                processed_count = len(processed_data.get(category, []))
                
                report["categories_processed"][category] = {
                    "raw_count": raw_count,
                    "processed_count": processed_count,
                    "filtered_count": raw_count - processed_count,
                    "retention_rate": (processed_count / raw_count * 100) if raw_count > 0 else 0
                }
                
                total_raw += raw_count
                total_processed += processed_count
        
        report["overall_stats"] = {
            "total_raw_items": total_raw,
            "total_processed_items": total_processed,
            "total_filtered_items": total_raw - total_processed,
            "overall_retention_rate": (total_processed / total_raw * 100) if total_raw > 0 else 0
        }
        
        return report
    
    def save_processed_data(self, data: Dict[str, Any], filename: str = None) -> str:
        """Save processed data to JSON file."""
        if filename is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"processed_family_friendly_data_{timestamp}.json"
            
        filepath = self.output_dir / filename
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            
        logger.info(f"Processed data saved to {filepath}")
        return str(filepath)

def main():
    """Main function to run data processing."""
    try:
        logger.info("Starting family-friendly data processing...")
        
        processor = FamilyFriendlyProcessor()
        
        # Load raw data
        raw_data = processor.load_raw_data()
        
        # Process data
        processed_data = processor.process_data(raw_data)
        
        # Create processing report
        report = processor.create_processing_report(raw_data, processed_data)
        
        # Save processed data
        data_filepath = processor.save_processed_data(processed_data)
        
        # Save processing report
        report_filepath = processor.save_processed_data(report, "processing_report.json")
        
        logger.info("Processing complete!")
        logger.info(f"- Processed data: {data_filepath}")
        logger.info(f"- Processing report: {report_filepath}")
        logger.info(f"- Overall retention rate: {report['overall_stats']['overall_retention_rate']:.1f}%")
        
        return 0
        
    except Exception as e:
        logger.error(f"Error during data processing: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())