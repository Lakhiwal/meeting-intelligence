import os
import time
import torch
import whisper
from transformers import pipeline
from pyannote.audio import Pipeline
from dotenv import load_dotenv

# Set aggressive timeouts
os.environ["HF_HUB_READ_TIMEOUT"] = "120"
os.environ["HF_HUB_ETAG_TIMEOUT"] = "120"

load_dotenv()
HF_TOKEN = os.getenv("HF_TOKEN")

def download():
    print("🚀 Starting High-Resilience Model Downloader...")
    
    # 1. Whisper Small
    while True:
        try:
            print("\n[1/3] Downloading Whisper model (small)...")
            whisper.load_model("small")
            print("âœ… Whisper Ready!")
            break
        except Exception as e:
            print(f"âŒ Whisper download failed: {e}. Retrying in 5s...")
            time.sleep(5)

    # 2. Summarizer
    while True:
        try:
            print("\n[2/3] Downloading Summarizer model...")
            pipeline("summarization", model="sshleifer/distilbart-cnn-12-6")
            print("âœ… Summarizer Ready!")
            break
        except Exception as e:
            print(f"âŒ Summarizer download failed: {e}. Retrying in 5s...")
            time.sleep(5)

    # 3. Diarization
    if HF_TOKEN:
        while True:
            try:
                print("\n[3/3] Downloading Diarization pipeline (3.1)...")
                Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", token=HF_TOKEN)
                print("âœ… Diarization Ready!")
                break
            except Exception as e:
                print(f"âŒ Diarization download failed: {e}. Retrying in 5s...")
                time.sleep(5)
    else:
        print("\nâš ï¸ Skipping Diarization: No HF_TOKEN found in .env")

    print("\nâœ¨ ALL MODELS DOWNLOADED SUCCESSFULLY! âœ¨")
    print("You can now run 'python app.py' and it will start instantly.")

if __name__ == "__main__":
    download()
