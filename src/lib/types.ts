export type UserRole = "host" | "presenter" | "judge";

export type EventStatus = "setup" | "live" | "voting" | "completed";
export type EventOrderMode = "random" | "alphabetical" | "manual";
export type EventVisibility = "private" | "public";

export type GroupStatus = "not_submitted" | "submitted" | "late";
export type PresentationType = "slides" | "video" | "demo" | "other";

export interface EventWithDetails {
  id: string;
  name: string;
  theme?: string;
  description?: string;
  joinCode: string;
  submissionDeadline: Date;
  maxPresentationTime: number;
  orderMode: EventOrderMode;
  visibility: EventVisibility;
  allowLateSubmissions: boolean;
  status: EventStatus;
  currentPresentationId?: string;
  judgingOpen: boolean;
  categories: CategoryWithRatings[];
  groups: GroupWithMembers[];
  judges: JudgeWithVotes[];
  host: {
    id: string;
    name: string;
    email: string;
  };
}

export interface CategoryWithRatings {
  id: string;
  name: string;
  description?: string;
  order: number;
}

export interface GroupWithMembers {
  id: string;
  name: string;
  emoji?: string;
  logo?: string;
  presentationType: PresentationType;
  submissionLink?: string;
  status: GroupStatus;
  submittedAt?: Date;
  presentationOrder?: number;
  members: {
    id: string;
    user: {
      id: string;
      name: string;
      email: string;
    };
    isLeader: boolean;
  }[];
}

export interface JudgeWithVotes {
  id: string;
  displayName: string;
  joinedAt: Date;
  votes: Vote[];
}

export interface Vote {
  id: string;
  groupId: string;
  ratings: {
    categoryId: string;
    stars: number;
  }[];
}

export interface ScoreResult {
  groupId: string;
  groupName: string;
  totalScore: number;
  averageScore: number;
  categoryScores: {
    categoryId: string;
    categoryName: string;
    averageStars: number;
    totalStars: number;
    voteCount: number;
  }[];
  voteCount: number;
}

export interface LeaderboardEntry {
  rank: number;
  group: GroupWithMembers;
  score: ScoreResult;
}
