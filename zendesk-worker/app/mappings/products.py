PRODUCT_MATCHERS = [
    {"name": "Core One", "matchers": ["coreone", "core_one", "a80"]},
    {"name": "Beacon", "matchers": ["beacon", "dw5a"]},
    {"name": "Fusion", "matchers": ["fusion", "a61"]},
    {"name": "Nexus", "matchers": ["nexus", "d36"]},
    {"name": "Style", "matchers": ["style", "a62"]},
    {"name": "Torch", "matchers": ["torch", "a18"]},
    {"name": "Solid", "matchers": ["solid", "d12"]},
    {"name": "Core One Pro", "matchers": ["coreonepro", "c1p", "core_one_pro", "a90"]},
    {"name": "Essential", "matchers": ["essential", "a39"]},
]

def classify_product(tags, product_type):
    tag_text = " ".join((tags or [])).lower()
    product_type = (product_type or "").lower()
    all_match_text = f"{tag_text} {product_type}"

    for item in PRODUCT_MATCHERS:
        if any(m in all_match_text for m in item["matchers"]):
            return item["name"]

    if "product__general" in tag_text or "other__other" in tag_text:
        return "Non-Specific"

    return "Non-Specific"
