import { lexicalScore } from './lexicalScorer.js';

export const hybridScore = (query, candidate, alpha) => {
    const semantic = candidate.score;
    const lexical = lexicalScore(query, candidate.query);
    const combined = alpha * semantic + (1 - alpha) * lexical;
    return { combined , semantic , lexical };
};