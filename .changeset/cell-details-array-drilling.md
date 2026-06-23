---
"@gtmgrid/desktop": minor
---

Cell details ("map it out") now treats array fields as first-class: each element is mappable on its own (`email[0]`, `email[1]`, …), arrays of objects drill all the way in (`phones[0].number`), and the whole array can still be mapped as a single value. Element drill-in is capped at 100 with the array container as the escape hatch.
