/**
 * Restricted faculty/subject list for the SLIDES catalog feature.
 * Separate from the main FACULTIES constant so the RAG document
 * subject tree is unaffected.
 *
 * NOTE: "Цитология" here deliberately differs from the main faculties.ts
 * entry "Цитология, обща хистология и ембриология". Confirm with the team
 * whether to unify the strings before adding them to the RAG document tree.
 */
import type { Faculty } from './types';

export const SLIDES_FACULTIES: Faculty[] = [
  {
    id: 'medicina',
    name: 'Факултет Медицина',
    specialties: [
      {
        id: 'medicina',
        name: 'Медицина',
        subjects: [
          'Патоанатомия и цитопатология',
          'Цитология',
          'Анатомия и хистология',
        ],
      },
    ],
  },
  {
    id: 'fvm',
    name: 'Факултет Ветеринарна медицина',
    specialties: [
      {
        id: 'veterinarna',
        name: 'Ветеринарна медицина',
        subjects: [], // to be populated when vet slides are added
      },
    ],
  },
];
