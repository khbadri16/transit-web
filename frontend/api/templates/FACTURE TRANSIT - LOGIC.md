# FACTURE DE TRANSIT — template + logic (for audit)

Template: `frontend/api/templates/FACTURE TRANSIT.docx`
(your original `FCT SNAX.docx` is untouched)

Nothing here is wired to the app yet — this is the placeholder map and the
calculation rules for you to check before the frontend/backend work starts.

---

## A — Header

| On the paper | Placeholder | Form field | Default shown |
|---|---|---|---|
| TRANSIT AOULA | `{{ transit_name }}` | Transit name (facture) | `TRANSIT AOULA` |
| AGREMENT N°04048 | `{{ agrement }}` | N° agrément | `04048` |
| NIF N°:196919250099510 | `{{ nif_transit }}` | NIF transit | `196919250099510` |
| DOIT : … | `{{ client_name }}` | Client name | empty |
| Adresse : … | `{{ client_adresse }}` | Adresse | empty |
| NIF : … | `{{ client_nif }}` | NIF client | empty |
| D10 N° : … | `{{ d10_numero }}` | N° déclaration | empty |
| DU … | `{{ d10_date }}` | Date déclaration | empty |

The three defaults (transit name, agrément, NIF) appear pre-filled in the form
and stay editable. **These fields are completely independent** from the Transit
name / Client name of the first part of the app — no link, as you asked.

---

## B — Marchandise table

Header stays: `MARQUE BL | DESIGNATION | NBRS CTN | POID BRUT`

**A single line**, four fields the user fills — no adding or removing rows:

```
{{ l.marque }} | {{ l.designation }} | {{ l.nbrs }} | {{ l.poids }}KG
```

`KG` is static in the template — the user types only the number (`33190.00`).
Both tables are locked to the same width and indent (9032 twips, fixed layout)
so they start and end on the same vertical lines.

---

## C — Facture table (the calculations)

Four columns: `LIBELLES | DEBOURS | PRODUIT | OBSERVATION`.
The 9 libellés are **fixed** in the template (not editable):

| # | Libellé | DEBOURS | PRODUIT | OBSERVATION |
|---|---|---|---|---|
| 1 | ECHANGE | `deb_echange` | `pro_echange` | `obs_echange` |
| 2 | MAGAZINAGE | `deb_magazinage` | `pro_magazinage` | `obs_magazinage` |
| 3 | DECHARGEMENT | `deb_dechargement` | `pro_dechargement` | `obs_dechargement` |
| 4 | RESTITUSION TC | `deb_restitution` | `pro_restitution` | `obs_restitution` |
| 5 | SURESTARIES | `deb_surestaries` | `pro_surestaries` | `obs_surestaries` |
| 6 | OUVERTURE DOSSIER | `deb_ouverture` | `pro_ouverture` | `obs_ouverture` |
| 7 | HONNORAIRE | `deb_honnoraire` | `pro_honnoraire` | `obs_honnoraire` |
| 8 | TVA 9% | `deb_tva` | `pro_tva` *(auto)* | `obs_tva` |
| 9 | TIMBRE | `deb_timbre` | `pro_timbre` | `obs_timbre` |

Then:

| Row | Placeholder |
|---|---|
| TAUX (debours) | `{{ taux_debours }}` |
| TAUX (produit) | `{{ taux_produit }}` |
| TOTAL TTC (cell merged over DEBOURS+PRODUIT) | `{{ total_ttc }}` |

### Extra libellés (added by the user)

Below TIMBRE the user can add any number of lines: a libellé of their own plus
DEBOURS / PRODUIT / OBSERVATION. They print in the same four columns and count
in the sums exactly like the fixed ones. Template side it is a
`{%p for e in extras %}` loop repeated in all four cells, so the columns always
stay aligned.

### Rules (confirmed)

1. **Free entry.** Every line can take a number in DEBOURS, in PRODUIT, or in
   both. Usually only one, but nothing is blocked.
2. **TVA 9% is automatic and live:**
   `tva = (ouverture PRODUIT + ouverture DEBOURS) × 0.09`
   → it follows the OUVERTURE DOSSIER amount whichever column it was typed in,
   and is always printed in the PRODUIT column. HONNORAIRE is **not** taxed.
   The result is **overridable**: type over it and it stays; the ↺ button gives
   it back to the automatic calculation.
3. **TAUX (debours)** = sum of the DEBOURS column, extras included.
4. **TAUX (produit)** = sum of the PRODUIT column — **including the TVA and the
   TIMBRE** — extras included.
5. **TOTAL TTC** = TAUX debours + TAUX produit.
6. **Pre-filled, still editable:** ouverture `20000.00`, timbre `436.00`. So an
   untouched invoice shows TVA 1800.00, TAUX produit 22236.00,
   TOTAL TTC 22236.00.
7. **Observation** is free text, one per line, printed on the same line as its
   libellé.
8. **Empty stays empty.** A line with no value prints a blank line, not `0.00`.
   Amounts print with 2 decimals (`20000` typed → `20000.00`, `3500,50` → `3500.50`).
9. **Date D10** is free text with a `jj/mm/aaaa` mask — the user types digits
   only and the slashes appear by themselves. No default, never today's date.
10. **Standalone.** The facture is always its own file in the ZIP
    (`FACTURE_TRANSIT_GENERATED.docx`) and never joins the merged Word option.

### Example (checked against the template render)

```
DEBOURS   MAGAZINAGE 5000.00                    → TAUX debours  5000.00
PRODUIT   OUVERTURE 20000.00 · TVA 1800.00
          TIMBRE 436.00                         → TAUX produit 22236.00
                                                → TOTAL TTC    27236.00
```

---

## Where it lives in the app

- Frontend: a **Facture** group with a hide/show toggle, like the Mandat MSC.
  Header fields, then the marchandise table (add/remove lines), then the
  invoice table with the 9 fixed libellés, the extra libellés, and the three
  live totals.
- Backend: `POST /api/generate` → `facture_enabled` + `facture` object.
  Totals and the TVA are recomputed server-side, so the printed document is
  always consistent with the rules above.
- The facture generates as soon as the **client name (DOIT)** is filled;
  everything else is optional.

## Remaining details (kept as-is unless you say otherwise)

- Trailing `.` after the client NIF and after the D10 date kept as on the paper.
- Extra libellés are printed uppercase, prefixed with `-` like the fixed ones.
- The nine fixed libellés are not editable — only the amounts.
- POID BRUT is typed without `KG`; the template prints it.
