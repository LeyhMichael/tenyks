import os
import pandas as pd
import anthropic
from dotenv import load_dotenv

load_dotenv()

INPUT_FILE = "DE_AT_Companies_BFF_2025.xlsx"
OUTPUT_FILE = "company_briefs_output.xlsx"

PROMPT_TEMPLATE = """You are a BCG consultant preparing a short intelligence brief on a company.

Company: {company}
Sector: {sector}
Industry: {industry}
Revenue 2024: {revenue} Mrd. EUR
Country: {country}

Write a brief with exactly 3 bullet points:
1. What the company does (one sentence)
2. Key strategic challenge or opportunity right now
3. A specific angle for how BCG could add value

Be concise, sharp, and avoid generic consulting language."""


def generate_brief(client, row):
    prompt = PROMPT_TEMPLATE.format(
        company=row["Unternehmen"],
        sector=row["BFF Subsektor"],
        industry=row["Industrie"],
        revenue=row["Umsatz 2024 (Mrd. €)"],
        country=row["Land"],
    )
    message = client.messages.create(
        model="claude-opus-4-5",
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}],
    )
    return message.content[0].text


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        print("Error: ANTHROPIC_API_KEY not found in .env file or environment.")
        return

    df = pd.read_excel(INPUT_FILE)
    companies = df[df["Unternehmen"].notna() & df["#"].apply(lambda x: str(x).isdigit())].copy()
    companies = companies.reset_index(drop=True)

    print(f"Found {len(companies)} companies. Generating briefs...\n")

    client = anthropic.Anthropic(api_key=api_key)

    briefs = []
    for i, row in companies.iterrows():
        print(f"[{i+1}/{len(companies)}] {row['Unternehmen']}...")
        try:
            brief = generate_brief(client, row)
            briefs.append(brief)
        except Exception as e:
            print(f"  Error: {e}")
            briefs.append("Error generating brief")

    companies["BCG Brief"] = briefs

    output_cols = ["Unternehmen", "BFF Subsektor", "Industrie", "Umsatz 2024 (Mrd. €)", "Land", "BCG Brief"]
    companies[output_cols].to_excel(OUTPUT_FILE, index=False)
    print(f"\nDone! Output saved to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
