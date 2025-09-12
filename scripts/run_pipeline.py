#!/usr/bin/env python3
"""
Family-Friendly Dataset Pipeline

This script runs the complete pipeline for generating the family-friendly dataset:
1. Data collection
2. Data processing  
3. Data validation
4. Final dataset generation
"""

import os
import sys
import subprocess
import logging
from pathlib import Path
from datetime import datetime

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

class DatasetPipeline:
    """Manages the complete dataset generation pipeline."""
    
    def __init__(self, scripts_dir: str = "scripts"):
        self.scripts_dir = Path(scripts_dir)
        self.pipeline_steps = [
            ("collect_data.py", "Data Collection"),
            ("process_data.py", "Data Processing"),
            ("validate_dataset.py", "Dataset Validation")
        ]
    
    def run_script(self, script_name: str, description: str) -> bool:
        """Run a pipeline script and return success status."""
        script_path = self.scripts_dir / script_name
        
        if not script_path.exists():
            logger.error(f"Script not found: {script_path}")
            return False
        
        logger.info(f"Starting: {description}")
        logger.info(f"Running: {script_path}")
        
        try:
            result = subprocess.run(
                [sys.executable, str(script_path)],
                capture_output=True,
                text=True,
                check=False
            )
            
            if result.returncode == 0:
                logger.info(f"✅ {description} completed successfully")
                if result.stdout:
                    logger.debug(f"Output: {result.stdout}")
                return True
            else:
                logger.error(f"❌ {description} failed with exit code {result.returncode}")
                if result.stderr:
                    logger.error(f"Error: {result.stderr}")
                if result.stdout:
                    logger.error(f"Output: {result.stdout}")
                return False
                
        except Exception as e:
            logger.error(f"❌ {description} failed with exception: {e}")
            return False
    
    def run_pipeline(self) -> bool:
        """Run the complete pipeline."""
        logger.info("🚀 Starting Family-Friendly Dataset Pipeline")
        logger.info(f"Pipeline started at: {datetime.now().isoformat()}")
        
        success_count = 0
        total_steps = len(self.pipeline_steps)
        
        for i, (script_name, description) in enumerate(self.pipeline_steps, 1):
            logger.info(f"\n📋 Step {i}/{total_steps}: {description}")
            
            if self.run_script(script_name, description):
                success_count += 1
            else:
                logger.error(f"❌ Pipeline failed at step {i}: {description}")
                break
        
        # Pipeline summary
        logger.info(f"\n📊 Pipeline Summary:")
        logger.info(f"   • Completed steps: {success_count}/{total_steps}")
        logger.info(f"   • Success rate: {success_count/total_steps*100:.1f}%")
        logger.info(f"   • Pipeline finished at: {datetime.now().isoformat()}")
        
        if success_count == total_steps:
            logger.info("🎉 Pipeline completed successfully!")
            return True
        else:
            logger.error("💥 Pipeline failed!")
            return False

def main():
    """Main function to run the pipeline."""
    try:
        pipeline = DatasetPipeline()
        success = pipeline.run_pipeline()
        return 0 if success else 1
        
    except Exception as e:
        logger.error(f"Pipeline error: {e}")
        return 1

if __name__ == "__main__":
    sys.exit(main())