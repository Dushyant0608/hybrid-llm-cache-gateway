from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

app = FastAPI()
model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")

class Query(BaseModel):
    text :str
    

@app.post("/embed")
async def embed(q : Query):
    vec = model.encode(q.text).tolist()
    return {"embedding" : vec}


