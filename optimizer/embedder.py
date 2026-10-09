from fastapi import FastAPI
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer, CrossEncoder
import torch

app = FastAPI()
embed_model = SentenceTransformer("sentence-transformers/all-MiniLM-L6-v2")
nli_model = CrossEncoder("cross-encoder/nli-deberta-v3-small")
LABELS = ["contradiction", "entailment", "neutral"]

class Query(BaseModel):
    text :str

class Pair(BaseModel):
    query: str
    candidate: str
   
@app.post("/embed")
async def embed(q : Query):
    vec = embed_model.encode(q.text).tolist()
    return {"embedding" : vec}

@app.post("/verify")
async def verify(p: Pair):
    raw = nli_model.predict([(p.query, p.candidate)])[0]
    probs = torch.softmax(torch.tensor(raw), dim=0).tolist()
    return dict(zip(LABELS,probs))

