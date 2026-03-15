import os
from groq import Groq

# Check if GROQ_API_KEY is available
if not os.environ.get("GROQ_API_KEY"):
    print("Please set the GROQ_API_KEY environment variable to run this script.")
    exit(1)

client = Groq()
completion = client.chat.completions.create(
    model="openai/gpt-oss-120b",
    messages=[
      {
        "role": "user",
        "content": "Hello, how are you? Provide a short response."
      }
    ],
    temperature=1,
    max_completion_tokens=8192,
    top_p=1,
    reasoning_effort="medium",
    stream=True,
    stop=None
)

for chunk in completion:
    print(chunk.choices[0].delta.content or "", end="")
print("\n")
