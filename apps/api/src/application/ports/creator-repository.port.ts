export interface CreatorRecord {
  id: string;
  name: string;
  whatsappNumber: string | null;
  email: string | null;
  tierPlan: string;
  createdAt: Date;
}

export interface CreatorRepositoryPort {
  create(input: { name: string; whatsappNumber: string; email?: string }): Promise<CreatorRecord>;
  findById(id: string): Promise<CreatorRecord | null>;
  findByEmail(email: string): Promise<CreatorRecord | null>;
}
