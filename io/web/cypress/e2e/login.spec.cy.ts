describe("template spec", () => {
  it("passes", () => {
    cy.visit("http://localhost:3000");
    cy.get("[data-cyid='loginMenu']").click();
    cy.get("[data-cyid='email']").click().type("wildananugrah@gmail.com");
    cy.get("[data-cyid='password']").click().type("p@ssw0rd");
    cy.wait(1000).get("[data-cyid='loginButton']").click();
  });
});
