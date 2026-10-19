import re
p = "/opt/mega-xo-v5-production/secrets/provider-signin.env"
s = open(p).read()
prices = {"CROWNS_100": (99, 4900), "CROWNS_525": (499, 24900), "CROWNS_1100": (999, 49900), "REMOVE_ADS": (399, 19900), "MEGA_PASS": (399, 19900)}
for pid, (usd, inr) in prices.items():
    s = re.sub(r"^DODO_PRICE_CENTS_" + pid + "=.*$", "DODO_PRICE_CENTS_" + pid + "=" + str(usd), s, flags=re.M)
    s = re.sub(r"^DODO_REGION_IN_" + pid + "=.*$", "DODO_REGION_IN_" + pid + "=" + str(inr), s, flags=re.M)
s = re.sub(r"^DODO_INTRO_ENDS_AT=.*$", "DODO_INTRO_ENDS_AT=2026-12-31T18:29:59Z", s, flags=re.M)
if "DODO_INTRO_PRICING_ACTIVE" in s:
    s = re.sub(r"^DODO_INTRO_PRICING_ACTIVE=.*$", "DODO_INTRO_PRICING_ACTIVE=false", s, flags=re.M)
else:
    s += "DODO_INTRO_PRICING_ACTIVE=false\n"
s = re.sub(r"^DODO_PROMO_PRODUCTS=.*$", "DODO_PROMO_PRODUCTS=crowns_100,crowns_525,crowns_1100,remove_ads,mega_pass", s, flags=re.M)
open(p, "w").write(s)
print("ENV_UPDATED")

