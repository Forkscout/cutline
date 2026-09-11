/**
 * Built-in recipes: what a kind of video usually needs, written down once.
 * A recipe fills the brief's gaps (never what the client said), tells the
 * agent what is worth asking and how the storyboard usually goes, and lists
 * the checks and formats for delivery. Recipes saved in the workspace sit
 * beside these.
 */

import type { Recipe } from "./types";

const builtIn = (r: Omit<Recipe, "version" | "updatedAt" | "builtIn">): Recipe => ({ ...r, version: 1, updatedAt: 0, builtIn: true });

const LANDSCAPE = { name: "Landscape 1080p", width: 1920, height: 1080 };
const VERTICAL = { name: "Vertical 1080×1920", width: 1080, height: 1920 };
const SQUARE = { name: "Square 1080×1080", width: 1080, height: 1080 };

export const RECIPES: Recipe[] = [
  builtIn({
    id: "explainer",
    name: "Explainer",
    description: "Someone explains an idea; graphics carry its structure, its steps and its numbers beside them.",
    brief: { layout: "side-panel", captions: "yes", platform: "YouTube", rules: ["Every number on screen is confirmed by the client before export."] },
    questions: [
      "What should a viewer understand, or do, after watching?",
      "Which numbers and names on screen must be exactly right?",
      "Is there a call to action at the end?",
    ],
    patterns: [
      "Full frame for the first line; into the side panel when the first idea needs a picture.",
      "One scene per idea: its title as it is named, then points, a flow, bars or a tree as it is explained.",
      "Back to full frame for the ending; leave 3 s or more between scenes where the face should carry it.",
    ],
    qa: ["lint_scene is clean on every scene.", "Every number confirmed (list_facts).", "No stretch longer than 20 s without a change on screen."],
    exports: [LANDSCAPE],
  }),
  builtIn({
    id: "screen-tutorial",
    name: "Screen tutorial",
    description: "A screen recording that teaches a task, with the presenter small in a corner.",
    brief: { layout: "pip", captions: "yes", platform: "YouTube" },
    questions: ["Who is it for — people new to the tool, or people who know it?", "Is anything on screen private: emails, keys, customer data?"],
    patterns: [
      "Keep the screen full and the presenter in a corner, clear of what is being clicked.",
      "A lower third names each step as it starts.",
      "Cut the waits: loading bars, typing that says nothing.",
    ],
    qa: ["Nothing private visible on screen.", "Every step named before it is done."],
    exports: [LANDSCAPE],
  }),
  builtIn({
    id: "shorts",
    name: "Shorts from a long video",
    description: "Vertical clips of the moments that stand on their own.",
    brief: { layout: "lower-thirds", captions: "yes", platform: "Reels, Shorts, TikTok" },
    questions: ["How many clips, and how long each?", "Any moments that must be in, or must stay out?"],
    patterns: [
      "Find three to five moments of 30–60 s that make sense without the rest.",
      "A hook in the first two seconds: start on the line, not the breath before it.",
      "Large captions in the lower middle, clear of the platform's buttons.",
    ],
    qa: ["Each clip makes sense alone.", "Captions sit inside the 9:16 safe area."],
    exports: [VERTICAL],
  }),
  builtIn({
    id: "podcast-clips",
    name: "Podcast clips",
    description: "Short, captioned clips from a conversation, each speaker named.",
    brief: { layout: "lower-thirds", captions: "yes", platform: "Instagram, YouTube Shorts, LinkedIn" },
    questions: ["Who are the speakers, and how should each be named?", "Which topics or moments are the ones to share?"],
    patterns: [
      "Name each speaker with a lower third the first time they speak.",
      "Cut to whoever is speaking; hold a wide shot for back-and-forth.",
      "Captions throughout; the line worth quoting stands out.",
    ],
    qa: ["Every speaker named correctly.", "No clip starts mid-sentence."],
    exports: [VERTICAL, SQUARE],
  }),
  builtIn({
    id: "product-demo",
    name: "Product demo",
    description: "What a product does, feature by feature, with a callout for each.",
    brief: { layout: "b-roll", captions: "yes", platform: "Website, YouTube" },
    questions: ["Which features, in what order, and which one leads?", "Any claims or numbers someone must approve?"],
    patterns: [
      "Open on the result, then show how to get there.",
      "One feature per scene: its name as a title, the benefit in one line.",
      "End on the product name and where to get it.",
    ],
    qa: ["Every claim on screen approved.", "Product names spelled the way the client spells them."],
    exports: [LANDSCAPE],
  }),
  builtIn({
    id: "ad",
    name: "Ad",
    description: "Fifteen to thirty seconds that make one point and ask for one thing.",
    brief: { captions: "yes", platform: "Instagram, YouTube pre-roll", tone: "Direct and energetic" },
    questions: ["What is the one thing a viewer should do after it?", "How long: 6, 15 or 30 seconds?", "Which formats: vertical, square, landscape?"],
    patterns: [
      "The point in the first three seconds, readable with the sound off.",
      "One idea, one proof, one ask.",
      "The brand and the call to action on screen for at least the last two seconds.",
    ],
    qa: ["Readable with the sound off.", "The call to action on screen long enough to read."],
    exports: [VERTICAL, SQUARE, LANDSCAPE],
  }),
];

export const recipeById = (id: string): Recipe | undefined => RECIPES.find((r) => r.id === id);
