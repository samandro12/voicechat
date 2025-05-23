# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

import base64
import json
import logging
import os
import time
import uuid

import azure.cognitiveservices.speech as speechsdk
from azure.cognitiveservices.speech import SpeechConfig, SpeechSynthesizer, ResultReason, CancellationReason, SpeechSynthesisOutputFormat
from azure.search.documents import SearchClient
from azure.search.documents.models import VectorizedQuery
from azure.core.credentials import AzureKeyCredential
from flask import Flask, request, jsonify, render_template, send_from_directory
from openai import AzureOpenAI

# Environment variables
# General
PORT = os.environ.get("PORT", "8000") # Default to 8000 if not set

# Azure Speech
SPEECH_KEY = os.environ.get("SPEECH_KEY")
SPEECH_REGION = os.environ.get("SPEECH_REGION")

# Azure OpenAI
AZURE_OPENAI_API_KEY = os.environ.get("AZURE_OPENAI_API_KEY")
AZURE_OPENAI_ENDPOINT = os.environ.get("AZURE_OPENAI_ENDPOINT")
AZURE_OPENAI_DEPLOYMENT_NAME = os.environ.get("AZURE_OPENAI_DEPLOYMENT_NAME")
AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME = os.environ.get("AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME")

# Azure AI Search
AZURE_SEARCH_SERVICE_ENDPOINT = os.environ.get("AZURE_SEARCH_SERVICE_ENDPOINT")
AZURE_SEARCH_INDEX_NAME = os.environ.get("AZURE_SEARCH_INDEX_NAME")
AZURE_SEARCH_API_KEY = os.environ.get("AZURE_SEARCH_API_KEY")

# Configuration for chat completion and TTS
# If True, the chat completion response will include audio output for the assistant's message.
# This is useful if you want to play the audio directly from the chat completion response.
# If False, the client will need to call the /synthesize endpoint separately to get the audio.
SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION = "true"  ##os.environ.get("SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION", "True").lower() == "true"
# This is the voice to be used for TTS if SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION is True.
VOICE_NAME_CHAT_COMPLETION = "en-US-AvaNeural"  ##os.environ.get("VOICE_NAME_CHAT_COMPLETION", "en-US-AvaNeural")

# Constants
MAX_RETRIES = 3
RETRY_DELAY = 2  # seconds

# Setup logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Initialize Flask app
app = Flask(__name__, static_folder='static', template_folder='static')

# Initialize Azure clients
# Speech SDK configuration
if not SPEECH_KEY or not SPEECH_REGION:
    raise ValueError("SPEECH_KEY and SPEECH_REGION must be set.")
speech_config = speechsdk.SpeechConfig(subscription=SPEECH_KEY, region=SPEECH_REGION)
speech_config.set_speech_synthesis_output_format(SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3) # Standard audio format
speech_synthesizer = speechsdk.SpeechSynthesizer(speech_config=speech_config, audio_config=None) # audio_config=None for in-memory synthesis

# Azure OpenAI client
if not AZURE_OPENAI_API_KEY or not AZURE_OPENAI_ENDPOINT or not AZURE_OPENAI_DEPLOYMENT_NAME or not AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME:
    raise ValueError("Azure OpenAI environment variables must be set.")
openai_client = AzureOpenAI(
    api_key=AZURE_OPENAI_API_KEY,
    api_version="2024-12-01-preview", # Recommended API version
    azure_endpoint=AZURE_OPENAI_ENDPOINT
)

# Azure AI Search client
search_client = None
if AZURE_SEARCH_SERVICE_ENDPOINT and AZURE_SEARCH_INDEX_NAME and AZURE_SEARCH_API_KEY:
    try:
        search_client = SearchClient(
            endpoint=AZURE_SEARCH_SERVICE_ENDPOINT,
            index_name=AZURE_SEARCH_INDEX_NAME,
            credential=AzureKeyCredential(AZURE_SEARCH_API_KEY)
        )
        logger.info(f"Successfully connected to Azure AI Search index '{AZURE_SEARCH_INDEX_NAME}'.")
    except Exception as e:
        logger.error(f"Failed to connect to Azure AI Search: {e}")
        search_client = None # Ensure client is None if connection fails
else:
    logger.warning("Azure AI Search environment variables not fully set. Search functionality will be disabled.")


def generate_embeddings(text):
    """Generates embeddings for the given text using Azure OpenAI."""
    if not openai_client:
        logger.error("OpenAI client not initialized for embeddings.")
        return None
    try:
        response = openai_client.embeddings.create(input=text, model=AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT_NAME)
        return response.data[0].embedding
    except Exception as e:
        logger.error(f"Error generating embeddings: {e}")
        return None

def search_documents(query_text, top_n=3):
    """Performs a vector search on Azure AI Search."""
    if not search_client:
        logger.warning("Search client not available. Skipping document search.")
        return []
    try:
        vector_query = VectorizedQuery(vector=generate_embeddings(query_text), k_nearest_neighbors=top_n, fields="contentVector")
        
        results = search_client.search(
            search_text=None, # Using vector search, so search_text can be None
            vector_queries=[vector_query],
            select=["title", "content", "source"] # Specify fields to retrieve
        )
        
        documents = []
        for result in results:
            documents.append({
                "title": result.get("title", "N/A"),
                "content": result.get("content", ""),
                "source": result.get("source", "N/A")
            })
        logger.info(f"Found {len(documents)} documents from search.")
        return documents
    except Exception as e:
        logger.error(f"Error searching documents: {e}")
        return []

def tts_ssml_and_send_audio_if_needed(text_to_speak, voice_name=VOICE_NAME_CHAT_COMPLETION):
    """
    Synthesizes speech from text using SSML and returns base64 encoded audio data.
    Only synthesizes if SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION is True.
    """
    if not SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION:
        return None

    ssml = f"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='{voice_name}'>{text_to_speak}</voice></speak>"
    logger.info(f"Synthesizing SSML: {ssml[:100]}...") # Log start of SSML

    for attempt in range(MAX_RETRIES):
        try:
            result = speech_synthesizer.speak_ssml_async(ssml).get()
            if result.reason == speechsdk.ResultReason.SynthesizingAudioCompleted:
                audio_data = result.audio_data
                logger.info(f"Speech synthesis completed. Audio data length: {len(audio_data)} bytes.")
                return base64.b64encode(audio_data).decode('utf-8')
            elif result.reason == speechsdk.ResultReason.Canceled:
                cancellation_details = result.cancellation_details
                logger.error(f"Speech synthesis canceled: {cancellation_details.reason}")
                if cancellation_details.reason == speechsdk.CancellationReason.Error:
                    logger.error(f"Error details: {cancellation_details.error_details}")
                break  # Don't retry on cancellation
        except Exception as e:
            logger.error(f"Attempt {attempt + 1} failed for TTS: {e}")
            if attempt < MAX_RETRIES - 1:
                time.sleep(RETRY_DELAY)
            else:
                logger.error("All TTS retries failed.")
    return None


def handle_chat_request(user_message, conversation_history):
    """Handles the chat request, incorporating search and OpenAI completion."""
    logger.info(f"Received user message: {user_message}")
    
    # Augment with search results if search client is available
    search_results_text = ""
    if search_client:
        documents = search_documents(user_message)
        if documents:
            search_results_text = "\n\nRelevant documents:\n"
            for doc in documents:
                search_results_text += f"- {doc.get('title', 'Document')} (Source: {doc.get('source', 'N/A')}): {doc.get('content', '')[:200]}...\n" # Truncate content for brevity
    
    # Prepare messages for OpenAI
    messages = [{"role": "system", "content": "You are a helpful AI assistant."}]
    messages.extend(conversation_history) # Add past conversation
    messages.append({"role": "user", "content": user_message + search_results_text})

    try:
        logger.info("Sending request to Azure OpenAI...")
        completion = openai_client.chat.completions.create(
            model=AZURE_OPENAI_DEPLOYMENT_NAME,
            messages=messages,
            max_tokens=800, # Adjust as needed
            temperature=0.7
        )
        assistant_response = completion.choices[0].message.content
        logger.info(f"Received response from Azure OpenAI: {assistant_response[:100]}...")

        audio_data_base64 = None
        if SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION:
            logger.info("Attempting to synthesize audio for the response.")
            audio_data_base64 = tts_ssml_and_send_audio_if_needed(assistant_response)
        
        return {
            "text": assistant_response,
            "audio": audio_data_base64, # This will be null if SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION is false or TTS fails
            "conversation_history": conversation_history + [{"role": "user", "content": user_message}, {"role": "assistant", "content": assistant_response}]
        }

    except Exception as e:
        logger.error(f"Error in OpenAI chat completion: {e}")
        return {"error": str(e), "text": "Sorry, I encountered an error.", "conversation_history": conversation_history}


@app.route('/')
def index():
    """Serves the main HTML page."""
    return render_template ('index.html', should_stream_audio=SHOULD_STREAM_AUDIO_FROM_CHAT_COMPLETION, azure_speech_region=SPEECH_REGION)


@app.route('/static/<path:path>')
def send_static(path):
    """Serves static files like JS, CSS."""
    return send_from_directory('static', path)


@app.route('/chat', methods=['POST'])
def chat():
    """Handles chat messages from the client."""
    try:
        data = request.get_json()
        user_message = data.get('message')
        conversation_history = data.get('conversation_history', []) # Expecting a list of {"role": "user/assistant", "content": "..."}

        if not user_message:
            return jsonify({"error": "Empty message received"}), 400

        response_data = handle_chat_request(user_message, conversation_history)
        return jsonify(response_data)

    except Exception as e:
        logger.error(f"Error in /chat endpoint: {e}")
        return jsonify({"error": "An internal server error occurred", "text": "Sorry, something went wrong on the server."}), 500


@app.route('/sts_token', methods=['GET'])
def get_sts_token():
    """Provides a Speech SDK token for client-side speech-to-text."""
    # This is a simplified token generation for example purposes.
    # In a production environment, you should use a more secure token service.
    # The Speech SDK can use the subscription key directly on the client for STT,
    # but using a token is generally recommended for better security if the key is not to be exposed.
    # However, for simplicity and common practice in samples, often the key itself is used by client if it has access.
    # This endpoint simulates fetching a short-lived token.
    
    # For this example, we'll just return the key and region if they are set,
    # as the client JS SDK can use them directly.
    # A true STS token would be fetched from the Azure STS service.
    if not SPEECH_KEY or not SPEECH_REGION:
        return jsonify({"error": "Speech key or region not configured on the server."}), 500
    
    # The client-side Speech SDK can be configured with a subscription key and region directly.
    # If you need to generate an authorization token, you would make a request to:
    # https://<REGION>.api.cognitive.microsoft.com/sts/v1.0/issueToken
    # with Ocp-Apim-Subscription-Key header.
    # For this sample, we'll just pass the necessary info for the client to init.
    return jsonify({'token': SPEECH_KEY, 'region': SPEECH_REGION})


if __name__ == '__main__':
    logger.info(f"Flask app starting on port {PORT}")
    # Note: For production, use a proper WSGI server like Gunicorn or Waitress.
    # Flask's built-in server is for development only.
    app.run(host='0.0.0.0', port=int(PORT), debug=False) # debug=False for production-like logging