# Extraction QA report

Source: `System_Map_Print.pdf` - generated 2026-10-16T19:33:17+00:00

## Summary

- Milepost labels decoded: **682** (626 milepost boxes, 56 interface ovals)
- Lowest glyph-match confidence: 0.971
- Tracks with milepost-calibrated geometry: **25** (A1, A2, C1, C2, C3, C4, CX3, L1, L2, L3, M1, M2, M3, R1, R2, S1, S2, W1, W2, W3, W4, Y1, Y2, Y3, Y4)
- Stations / yards named: 51

| status | count | meaning |
|---|---|---|
| anchored | 269 | track-specific milepost used to calibrate its track |
| line_level | 280 | line milepost (e.g. `4.37C`) projected onto each track of the line |
| facility | 44 | milepost of a facility (vent room, substation...) with no track suffix |
| out_of_sequence | 25 | **review** - conflicts with neighbouring mileposts, not used |
| unanchored | 9 | **review** - leader could not be traced to a track |
| unused | 55 | **review** - decoded but not used (track has no calibrated route) |
| unreadable | 0 | **review** - text did not parse as a milepost |

## Track coverage

| track | MP range | pieces | anchors (explicit + line-level) |
|---|---|---|---|
| A1 | 0.22-10.86, 11.01-23.98 | 2 | 22 + 46 |
| A2 | 0.27-10.86, 11.02-23.98 | 2 | 18 + 43 |
| C1 | 0.0-4.15, 4.32-28.73 | 2 | 29 + 73 |
| C2 | 0.0-28.98 | 1 | 25 + 79 |
| C3 | 2.08-2.65, 12.24-12.42, 28.98-29.19 | 3 | 5 + 1 |
| C4 | 2.04-2.64 | 1 | 3 + 3 |
| CX3 | 1.84-2.31 | 1 | 2 + 0 |
| L1 | 11.15-11.47, 11.76-24.84 | 2 | 12 + 29 |
| L2 | 11.68-24.53 | 1 | 3 + 31 |
| L3 | 14.12-19.61 | 1 | 3 + 3 |
| M1 | 0.0-16.35 | 1 | 40 + 40 |
| M2 | 0.0-16.24 | 1 | 16 + 41 |
| M3 | 15.17-16.52 | 1 | 10 + 7 |
| R1 | 2.45-12.99 | 1 | 4 + 38 |
| R2 | 2.45-2.49, 3.14-12.99 | 2 | 4 + 39 |
| S1 | 25.3-28.5 | 1 | 0 + 13 |
| S2 | 25.35-28.5 | 1 | 0 + 12 |
| W1 | 16.6-24.61 | 1 | 20 + 9 |
| W2 | 16.54-24.7 | 1 | 28 + 10 |
| W3 | 16.79-16.98, 20.84-20.98, 24.13-24.51 | 3 | 8 + 2 |
| W4 | 24.46-24.61 | 1 | 2 + 0 |
| Y1 | 0.17-1.0 | 1 | 3 + 1 |
| Y2 | 0.17-0.45, 0.58-0.82 | 2 | 3 + 2 |
| Y3 | 0.07-0.45, 0.75-0.99 | 2 | 2 + 4 |
| Y4 | 0.75-0.99 | 1 | 1 + 2 |

## Out-of-sequence mileposts (check the drawing)

| label | page position (pt) | tracks |
|---|---|---|
| `18.07A1` | x 5198, y 897 | A1 |
| `23.56A1` | x 5697, y 897 | A1 |
| `0.23A2` | x 3964, y 1024 | A2 |
| `18.84A2` | x 5395, y 897 | A2 |
| `19.15A2` | x 5558, y 897 | A2 |
| `19.65C1` | x 4853, y 418 | C1 |
| `20.35C1` | x 5185, y 418 | C1 |
| `22.29C1` | x 5344, y 390 | C1 |
| `1.29C2` | x 3763, y 812 | C2 |
| `22.11C2` | x 5344, y 190 | C2 |
| `23.64C2` | x 5557, y 146 | C2 |
| `25.90C2` | x 5663, y 146 | C2 |
| `0.00L1` | x 3830, y 1076 | L1 |
| `0.00L2` | x 3791, y 1076 | L2 |
| `16.24M1` | x 2123, y 904 | M1 |
| `0.03M2` | x 3916, y 1064 | M2 |
| `0.25M2` | x 3816, y 1076 | M2 |
| `0.37M2` | x 3761, y 1114 | M2 |
| `15.65M2` | x 2361, y 1110 | M2 |
| `24.39W1` | x 235, y 904 | W1 |
| `23.72W2` | x 612, y 1110 | W2 |
| `24.36W3` | x 339, y 904 | W3 |
| `0.87Y1` | x 971, y 921 | Y1 |
| `0.99Y1` | x 1040, y 904 | Y1 |
| `0.82Y3` | x 783, y 1110 | Y3 |

## Mileposts whose leader could not be followed to a track

| label | page position (pt) | tracks |
|---|---|---|
| `10.94A` | x 4533, y 1120 | A |
| `2.26C2` | x 3720, y 434 | C2 |
| `29.32C2` | x 5998, y 376 | C2 |
| `24.83L2` | x 6009, y 550 | L2 |
| `16.24M1` | x 345, y 633 | M1 |
| `13.11R` | x 2767, y 158 | R |
| `13.15R` | x 2754, y 158 | R |
| `13.28R` | x 2732, y 158 | R |
| `24.72W` | x 170, y 904 | W |

## Decoded but unused

| label | page position (pt) | tracks |
|---|---|---|
| `11.28A` | x 4689, y 904 | A |
| `18.75A` | x 5341, y 1173 | A |
| `18.85A` | x 5412, y 1173 | A |
| `17.54C` | x 4582, y 376 | C |
| `17.63C` | x 4613, y 376 | C |
| `19.54C` | x 4776, y 186 | C |
| `19.91C` | x 4772, y 376 | C |
| `21.28C` | x 5326, y 345 | C |
| `21.80C` | x 5407, y 381 | C |
| `22.20C` | x 5354, y 345 | C |
| `23.65CS` | x 5622, y 146 | CS |
| `23.97CS` | x 5646, y 146 | CS |
| `0.25CX` | x 3886, y 939 | CX |
| `0.84CX` | x 3905, y 862 | CX |
| `1.38CX` | x 3906, y 792 | CX |
| `16.40DTF` | x 2035, y 836 | DTF |
| `17.45HTT` | x 5176, y 897 | HTT |
| `18.78HTT` | x 5373, y 897 | HTT |
| `19.17HTT` | x 5566, y 897 | HTT |
| `19.71HTT` | x 5584, y 897 | HTT |
| `1.46KX` | x 3763, y 763 | KX |
| `1.51KX` | x 3763, y 739 | KX |
| `1.65KX` | x 3763, y 688 | KX |
| `15.8L` | x 5406, y 550 | L |
| `18.93L` | x 5467, y 550 | L |
| `19.19L` | x 5517, y 771 | L |
| `14.54L3` | x 5377, y 771 | L3 |
| `15.04M` | x 2583, y 904 | M |
| `15.16M2` | x 2542, y 1110 | M2 |
| `14.88ME` | x 2604, y 1110 | ME |
| `14.99ME` | x 2585, y 1110 | ME |
| `0.00MX` | x 3879, y 939 | MX |
| `0.47MX` | x 3721, y 1073 | MX |
| `24.76S` | x 5844, y 1119 | S |
| `25.30S` | x 5887, y 897 | S |
| `25.52S` | x 5956, y 1120 | S |
| `25.63S` | x 5989, y 1120 | S |
| `27.76S` | x 6063, y 1120 | S |
| `27.97S` | x 6107, y 897 | S |
| `28.26S` | x 6142, y 897 | S |
| `28.27S` | x 6162, y 897 | S |
| `28.49S` | x 6211, y 897 | S |
| `28.58S` | x 6251, y 1120 | S |
| `28.67S` | x 6261, y 897 | S |
| `28.72S` | x 6267, y 1120 | S |
| `28.75S` | x 6282, y 897 | S |
| `28.81S` | x 6289, y 1120 | S |
| `28.90S` | x 6324, y 897 | S |
| `28.96S` | x 6332, y 1120 | S |
| `28.97S` | x 6351, y 1120 | S |
| `29.00S` | x 6360, y 897 | S |
| `29.12S` | x 6381, y 1120 | S |
| `16.51W` | x 2009, y 1110 | W |
| `23.29W` | x 744, y 904 | W |
| `0.83Y4` | x 783, y 899 | Y4 |
