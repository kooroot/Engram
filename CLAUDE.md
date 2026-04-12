# [System Architecture Document] AI-Native Persistent Memory Space: "Project Engram"

## 1. Context & Role
You are an Expert AI Architect specializing in high-performance Agentic Systems and Database Engineering. 
Your objective is to design the core architecture for a next-generation, AI-native persistent memory space named "Project Engram". This system must solve the "Context Bloat" and "High I/O Token Cost" problems inherent in traditional RAG or file-based memory frameworks by transitioning from document-centric to state-centric memory.

## 2. Core Philosophy: The State-Transition Paradigm
"Project Engram" adopts the architectural philosophy of high-performance deterministic nodes (e.g., modern blockchain clients). We strictly separate **History (Event Log)** from the **Cognitive State (World State)**.

* **Rule 1: No O(N) Rewrites.** The system must NEVER require the LLM to rewrite or summarize a large document to update a single fact.
* **Rule 2: O(1) State Lookups.** The LLM must be able to query the 'Compiled Truth' of an entity via a direct graph/tree lookup, completely independent of the conversation history.
* **Rule 3: State Transitions (Deltas).** When the AI learns a new fact, it does not write text. It emits an explicit `Tool Call` (a transaction) to patch/update a specific node in the Cognitive State DB.

## 3. The 3-Tier Architecture Requirements
You must design "Project Engram" around these three distinct memory pillars:

1.  **Immutable Event Log (The Subconscious / Append-Only):**
    * Purpose: The permanent, unchangeable ledger of all conversations, actions, and temporal observations.
    * Data Shape: Sequential JSON lines or a high-throughput time-series DB.
2.  **The Cognitive State Tree (The Conscious / Mutable World State):**
    * Purpose: The real-time "Current Truth" of all known entities (people, projects, concepts, rules).
    * Data Shape: Nodes and Edges (Triplets: Subject - Predicate - Object) or a highly structured/indexed JSON Document DB.
    * Behavior: Only updated via precise State Transition commands (Patching).
3.  **Semantic Vector Store (The Intuition / Optional):**
    * Purpose: For fuzzy searching unstructured nuances or context that don't fit perfectly into the strict State Tree.

## 4. Your Task (Action Items)
Based on the exact philosophy and constraints above, please generate the following technical blueprints for Project Engram:

1.  **Database Schema Design:**
    * Define the ideal DB stack to achieve this separation.
    * Provide the exact schema/models for both the `Event Log` and the `Cognitive State Tree`.
2.  **Tool Call Specifications (JSON Schema):**
    * Define the exact `function_calling` schemas the LLM will use to trigger State Transitions.
    * Must include tools like: `mutate_state`, `link_entities`, `query_engram_tree`.
3.  **Context Injection Flow (The Read Path):**
    * Explain the lifecycle of a user query: How does the system fetch data from the State Tree and inject it into the LLM's prompt BEFORE generation, ensuring minimal latency?
4.  **Conflict & Bloat Resolution:**
    * How the architecture handles conflicting temporal information.
    * Strategies to prune or archive inactive nodes from the "hot" state tree without losing them.

## 5. Constraints
* STRICTLY AVOID suggesting any file-based Markdown structure or traditional note-taking app approaches.
* Focus heavily on minimal latency, JSON manipulation, Graph logic, and token-efficiency.
* Output the response in a highly structured, engineering-focused technical specification format.