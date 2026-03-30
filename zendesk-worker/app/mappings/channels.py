def classify_channel(tags, order, purchased_from):
    tag_list = [str(t).lower() for t in (tags or [])]
    lower_tags = ", ".join(tag_list)
    lower_order = str(order or "").lower()
    lower_purchased_from = str(purchased_from or "").lower()

    if (
        "shopify" in lower_tags
        or "case__shopify" in lower_tags
        or lower_order.startswith("cc")
        or "ceretone website" in lower_purchased_from
        or "ceretone.com (usa)" in lower_purchased_from
    ):
        return "Ceretone USA"

    if (
        "case__shopifyca" in lower_tags
        or lower_order.startswith("ca")
        or "ceretone.ca (canada)" in lower_purchased_from
    ):
        return "Ceretone CA"

    if (
        "amazon" in lower_tags
        or "case__amazon" in lower_tags
        or "amazon" in lower_purchased_from
    ):
        return "Amazon"

    if (
        "case__amazonca" in lower_tags
        or "amazon (canada)" in lower_purchased_from
    ):
        return "Amazon CA"

    if (
        "walmart" in lower_tags
        or "walmart" in lower_order
        or "walmart" in lower_purchased_from
    ):
        return "Walmart"

    if (
        "case__walmartca" in lower_tags
        or "walmart (canada)" in lower_purchased_from
    ):
        return "Walmart CA"

    if (
        "aafes" in lower_tags
        or "case__aafes" in lower_tags
        or "aafes (shopmyexchange.com)" in lower_purchased_from
    ):
        return "AAFES"

    if (
        "cardinal" in lower_tags
        or "case__fsastore" in lower_tags
        or "case__cardinal_health" in lower_tags
        or "cardinal health (fsa/hsa)" in lower_purchased_from
    ):
        return "Cardinal Health"

    if (
        "tjx" in lower_tags
        or "case__tjx" in lower_tags
        or "tjx (tj max, marshals, etc)" in lower_purchased_from
    ):
        return "TJX"

    if (
        "oci" in lower_tags
        or "case__oci" in lower_tags
        or "oci (home depot, bed bath & beyond)" in lower_purchased_from
    ):
        return "OCI"

    if (
        "knocking" in lower_tags
        or "case__knocking" in lower_tags
        or "knocking (cbs)" in lower_purchased_from
    ):
        return "Knocking"

    return "Non-Specific"
