#!/usr/bin/env python3
"""
Family-Friendly Dataset Validation Script

This script validates the processed dataset to ensure quality and
family-friendly standards are maintained.
"""

import os
import sys
import json
import pandas as pd
from datetime import datetime
from pathlib import Path
import logging
from typing import Dict, List, Any, Tuple

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class DatasetValidator:
    """Validates family-friendly dataset for quality and standards."""
    
    def __init__(self, input_dir: str = "data/processed", output_dir: str = "data/final"):
        self.input_dir = Path(input_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.validation_errors = []
        self.validation_warnings = []
        
    def load_processed_data(self, filename: str = None) -> Dict[str, Any]:
        """Load processed data from JSON file."""
        if filename is None:
            # Find the most recent processed data file
            json_files = list(self.input_dir.glob("processed_family_friendly_data_*.json"))
            if not json_files:
                raise FileNotFoundError("No processed data files found")
            filename = max(json_files, key=lambda x: x.stat().st_mtime).name
            
        filepath = self.input_dir / filename
        logger.info(f"Loading processed data from {filepath}")
        
        with open(filepath, 'r', encoding='utf-8') as f:
            return json.load(f)
    
    def validate_required_fields(self, item: Dict[str, Any], category: str, required_fields: List[str]) -> bool:
        """Validate that required fields are present and valid."""
        is_valid = True
        
        for field in required_fields:
            if field not in item:
                self.validation_errors.append(
                    f"Missing required field '{field}' in {category} item: {item.get('title', 'Unknown')}"
                )
                is_valid = False
            elif not item[field]:
                self.validation_warnings.append(
                    f"Empty required field '{field}' in {category} item: {item.get('title', 'Unknown')}"
                )
        
        return is_valid
    
    def validate_data_types(self, item: Dict[str, Any], category: str) -> bool:
        """Validate data types for common fields."""
        is_valid = True
        
        # Check rating is numeric if present
        if 'rating' in item and item['rating'] is not None:
            if isinstance(item['rating'], str):
                # Allow string ratings like 'G', 'PG'
                pass
            elif isinstance(item['rating'], (int, float)):
                if not (0 <= item['rating'] <= 5):
                    self.validation_warnings.append(
                        f"Rating {item['rating']} outside expected range [0-5] for {item.get('title', 'Unknown')}"
                    )
        
        # Check year is valid if present
        if 'year' in item and item['year'] is not None:
            try:
                year = int(item['year'])
                current_year = datetime.now().year
                if not (1900 <= year <= current_year + 2):
                    self.validation_warnings.append(
                        f"Year {year} outside expected range for {item.get('title', 'Unknown')}"
                    )
            except (ValueError, TypeError):
                self.validation_errors.append(
                    f"Invalid year format '{item['year']}' for {item.get('title', 'Unknown')}"
                )
                is_valid = False
        
        # Check family_friendly is boolean
        if 'family_friendly' in item:
            if not isinstance(item['family_friendly'], bool):
                self.validation_errors.append(
                    f"family_friendly must be boolean for {item.get('title', 'Unknown')}"
                )
                is_valid = False
        
        return is_valid
    
    def validate_family_friendly_standards(self, item: Dict[str, Any], category: str) -> bool:
        """Validate that item meets family-friendly standards."""
        is_valid = True
        
        # All items should be marked as family_friendly
        if not item.get('family_friendly', False):
            self.validation_errors.append(
                f"Item not marked as family_friendly: {item.get('title', 'Unknown')}"
            )
            is_valid = False
        
        # Check for inappropriate content warnings
        inappropriate_keywords = ['explicit', 'graphic', 'disturbing', 'adult']
        content_warnings = item.get('content_warnings', [])
        
        for warning in content_warnings:
            warning_lower = warning.lower()
            for keyword in inappropriate_keywords:
                if keyword in warning_lower:
                    self.validation_errors.append(
                        f"Inappropriate content warning '{warning}' for {item.get('title', 'Unknown')}"
                    )
                    is_valid = False
        
        return is_valid
    
    def validate_category(self, items: List[Dict[str, Any]], category: str) -> Tuple[int, int]:
        """Validate all items in a category."""
        logger.info(f"Validating {len(items)} items in category: {category}")
        
        # Define required fields by category
        required_fields = {
            'books': ['title', 'author'],
            'movies': ['title', 'director'],
            'games': ['title', 'platform'],
            'default': ['title']
        }
        
        category_required = required_fields.get(category, required_fields['default'])
        
        valid_count = 0
        invalid_count = 0
        
        for item in items:
            item_valid = True
            
            # Validate required fields
            if not self.validate_required_fields(item, category, category_required):
                item_valid = False
            
            # Validate data types
            if not self.validate_data_types(item, category):
                item_valid = False
            
            # Validate family-friendly standards
            if not self.validate_family_friendly_standards(item, category):
                item_valid = False
            
            if item_valid:
                valid_count += 1
            else:
                invalid_count += 1
        
        return valid_count, invalid_count
    
    def validate_dataset(self, data: Dict[str, Any]) -> Dict[str, Any]:
        """Validate the entire dataset."""
        logger.info("Starting dataset validation...")
        
        validation_results = {
            "validation_date": datetime.now().isoformat(),
            "categories": {},
            "overall_stats": {},
            "errors": [],
            "warnings": []
        }
        
        total_valid = 0
        total_invalid = 0
        
        for category, items in data.items():
            if isinstance(items, list):
                valid_count, invalid_count = self.validate_category(items, category)
                
                validation_results["categories"][category] = {
                    "total_items": len(items),
                    "valid_items": valid_count,
                    "invalid_items": invalid_count,
                    "validity_rate": (valid_count / len(items) * 100) if items else 0
                }
                
                total_valid += valid_count
                total_invalid += invalid_count
        
        validation_results["overall_stats"] = {
            "total_items": total_valid + total_invalid,
            "valid_items": total_valid,
            "invalid_items": total_invalid,
            "overall_validity_rate": (total_valid / (total_valid + total_invalid) * 100) if (total_valid + total_invalid) > 0 else 0
        }
        
        validation_results["errors"] = self.validation_errors
        validation_results["warnings"] = self.validation_warnings
        
        return validation_results
    
    def create_final_dataset(self, data: Dict[str, Any], validation_results: Dict[str, Any]) -> Dict[str, Any]:
        """Create the final validated dataset."""
        logger.info("Creating final dataset...")
        
        final_dataset = {
            "metadata": {
                "creation_date": datetime.now().isoformat(),
                "dataset_name": "Family-Friendly Content Dataset",
                "version": "1.0.0",
                "description": "A curated collection of family-friendly books, movies, and games",
                "total_items": validation_results["overall_stats"]["total_items"],
                "validity_rate": validation_results["overall_stats"]["overall_validity_rate"],
                "categories": list(validation_results["categories"].keys())
            },
            "validation_summary": {
                "errors_count": len(validation_results["errors"]),
                "warnings_count": len(validation_results["warnings"]),
                "overall_valid": validation_results["overall_stats"]["valid_items"],
                "overall_invalid": validation_results["overall_stats"]["invalid_items"]
            }
        }
        
        # Copy the data categories
        for category, items in data.items():
            if isinstance(items, list):
                final_dataset[category] = items
        
        return final_dataset
    
    def save_validation_results(self, results: Dict[str, Any], filename: str = None) -> str:
        """Save validation results to JSON file."""
        if filename is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            filename = f"validation_results_{timestamp}.json"
            
        filepath = self.output_dir / filename
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=2, ensure_ascii=False)
            
        logger.info(f"Validation results saved to {filepath}")
        return str(filepath)
    
    def save_final_dataset(self, dataset: Dict[str, Any], filename: str = None) -> str:
        """Save final dataset to JSON file."""
        if filename is None:
            filename = "family_friendly_dataset.json"
            
        filepath = self.output_dir / filename
        
        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(dataset, f, indent=2, ensure_ascii=False)
            
        logger.info(f"Final dataset saved to {filepath}")
        return str(filepath)

def main():
    """Main function to run dataset validation."""
    try:
        logger.info("Starting dataset validation...")
        
        validator = DatasetValidator()
        
        # Load processed data
        data = validator.load_processed_data()
        
        # Validate dataset
        validation_results = validator.validate_dataset(data)
        
        # Create final dataset
        final_dataset = validator.create_final_dataset(data, validation_results)
        
        # Save results
        validation_filepath = validator.save_validation_results(validation_results)
        dataset_filepath = validator.save_final_dataset(final_dataset)
        
        # Log summary
        logger.info("Validation complete!")
        logger.info(f"- Validation results: {validation_filepath}")
        logger.info(f"- Final dataset: {dataset_filepath}")
        logger.info(f"- Overall validity rate: {validation_results['overall_stats']['overall_validity_rate']:.1f}%")
        logger.info(f"- Errors: {len(validation_results['errors'])}")
        logger.info(f"- Warnings: {len(validation_results['warnings'])}")
        
        # Return non-zero exit code if there are validation errors
        return 1 if validation_results['errors'] else 0
        
    except Exception as e:
        logger.error(f"Error during validation: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())