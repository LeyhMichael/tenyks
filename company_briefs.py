import os
import pandas as pd

INPUT_FILE = "DE_AT_Companies_BFF_2025.xlsx"
OUTPUT_FILE = "company_briefs_output.xlsx"


def generate_mock_brief(row):
    return (
        f"• {row['Unternehmen']} is a leading {row['Industrie']} company in {row['Land']} "
        f"with €{row['Umsatz 2024 (Mrd. €)']}bn revenue operating in the {row['BFF Subsektor']} sector.\n"
        f"• [MOCK] Key strategic challenge: navigating cost pressure and digital transformation "
        f"in a rapidly shifting {row['BFF Subsektor']} landscape.\n"
        f"• [MOCK] BCG angle: operational excellence and AI-driven efficiency programme "
        f"to protect margins and accelerate growth."
    )


def main():
    df = pd.read_excel(INPUT_FILE)

    companies = df[df["Unternehmen"].notna() & df["#"].apply(lambda x: str(x).isdigit())].copy()
    companies = companies.reset_index(drop=True)

    print(f"Found {len(companies)} companies. Generating mock briefs...\n")

    briefs = []
    for i, row in companies.iterrows():
        print(f"[{i+1}/{len(companies)}] {row['Unternehmen']}...")
        briefs.append(generate_mock_brief(row))

    companies["BCG Brief"] = briefs

    output_cols = ["Unternehmen", "BFF Subsektor", "Industrie", "Umsatz 2024 (Mrd. €)", "Land", "BCG Brief"]
    companies[output_cols].to_excel(OUTPUT_FILE, index=False)
    print(f"\nDone! Output saved to {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
