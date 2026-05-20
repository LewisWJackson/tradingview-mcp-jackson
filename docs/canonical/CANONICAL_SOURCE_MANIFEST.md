\# CANONICAL SOURCE MANIFEST



\## Canonical Strategy Source



Primary methodology document used for rule extraction and RAG grounding.



Source Package Location:

docs/canonical/



Canonical Files:



1\. Estrategias.pdf

&#x20;  Original document from course material.



2\. Estrategia Gemini v4.md

&#x20;  Structured interpretation of the original document including

&#x20;  textual explanations of each strategy and descriptions of charts.



3\. Estrategia\_structured.json

&#x20;  Machine-readable structured representation used for automated

&#x20;  rule extraction.



4\. Estrategia\_canonical.md

&#x20;  Canonical human-readable representation of the strategy logic.



5\. images/

&#x20;  Visual patterns corresponding to each strategy.



\## Purpose



This canonical package replaces the failed automatic parsing

process due to the source document being primarily image-based.



The structured JSON and markdown representations are considered

the authoritative text source for rule extraction.



\## Usage in Pipeline



This source feeds the following pipeline steps:



Corpus consolidation

Semantic chunking

Metadata enrichment

Rule extraction

RAG indexing



\## Strategy Count



Total strategies defined: 11



\## Status



Declared canonical source for trading methodology.

