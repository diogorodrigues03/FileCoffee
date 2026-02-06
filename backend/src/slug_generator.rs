use rand::seq::SliceRandom;

const ADJECTIVES: &[&str] = &[
    "hot", "cold", "iced", "dark", "light", "sweet", "bitter", "frothy", "milky", "roasted",
    "decaf", "strong", "smooth", "creamy", "fresh", "bold", "rich", "steaming", "foamy", "tasty",
];

const NOUNS: &[&str] = &[
    "coffee",
    "bean",
    "espresso",
    "latte",
    "mocha",
    "cappuccino",
    "brew",
    "roast",
    "cup",
    "mug",
    "barista",
    "aroma",
    "steam",
    "filter",
    "press",
    "macchiato",
    "americano",
    "cortado",
    "grind",
    "pour",
];

pub fn generate_slug() -> String {
    let mut rng = rand::thread_rng();
    let adj = ADJECTIVES.choose(&mut rng).unwrap_or(&"tasty");
    let noun = NOUNS.choose(&mut rng).unwrap_or(&"coffee");
    // Add a random number to drastically reduce collision probability
    // e.g., "hot-espresso-42"
    let num: u16 = rand::random::<u16>() % 1000;

    format!("{}-{}-{}", adj, noun, num)
}
